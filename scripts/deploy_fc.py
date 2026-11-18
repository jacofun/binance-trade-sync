"""Update an existing FC function; no environment secrets or trigger changes."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import zipfile

import yaml
from alibabacloud_fc20230330.client import Client
from alibabacloud_fc20230330 import models
from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_util.models import RuntimeOptions


class DeployError(Exception):
    pass


def target_from_yaml(path):
    document = yaml.safe_load(Path(path).read_text())
    try:
        resources = document["resources"]
        if len(resources) != 1:
            raise ValueError()
        resource = next(iter(resources.values()))
        if resource["component"] != "fc3":
            raise ValueError()
        props = resource["props"]
        if not re.fullmatch(r"[a-z0-9-]+", props["region"]):
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", props["functionName"]):
            raise ValueError()
        if props["runtime"] != "nodejs20" or props["handler"] != "index.handler":
            raise ValueError()
        if props["timeout"] != 300:
            raise ValueError()
        return props
    except (KeyError, TypeError, ValueError, AttributeError):
        raise DeployError("s.yaml deployment target is invalid.") from None


def load_zip(path):
    data = Path(path).read_bytes()
    # Keep the Base64 request comfortably inside the direct-upload limit.
    if not 0 < len(data) <= 20 * 1024 * 1024:
        raise DeployError("ZIP must be between 1 byte and 20 MiB for direct upload.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            required = {"index.js", "package.json", "src/sync.js", "src/auth.js", "node_modules/ali-oss/package.json"}
            if not required.issubset(names) or len(names) != len(set(names)):
                raise DeployError("ZIP layout or dependencies are invalid.")
            if any(name.startswith("/") or ".." in Path(name).parts or
                   any(part.startswith(".env") or part in {".git", ".github"} for part in Path(name).parts)
                   for name in names):
                raise DeployError("ZIP contains a forbidden path or configuration file.")
    except zipfile.BadZipFile:
        raise DeployError("Deployment package is not a ZIP file.") from None
    return data


def crc64(data):
    # Reflected ECMA-182, with all-one init/xorout (same as Go crc64.ECMA).
    polynomial = 0xC96C5795D7870F42
    table = []
    for byte in range(256):
        value = byte
        for _ in range(8):
            value = (value >> 1) ^ (polynomial if value & 1 else 0)
        table.append(value)
    result = 0xFFFFFFFFFFFFFFFF
    for byte in data:
        result = table[(result ^ byte) & 0xFF] ^ (result >> 8)
    return str(result ^ 0xFFFFFFFFFFFFFFFF)


PRESERVED_FIELDS = (
    "environment_variables", "role", "cpu", "memory_size", "disk_size", "internet_access",
    "vpc_config", "nas_config", "oss_mount_config", "log_config", "resource_group_id",
    "instance_concurrency", "instance_isolation_mode", "session_affinity", "layers",
    "custom_dns", "instance_lifecycle_config", "disable_ondemand", "disable_inject_credentials",
)


def value_of(value):
    if hasattr(value, "to_map"):
        return value.to_map()
    if isinstance(value, list):
        return [value_of(item) for item in value]
    return value


def snapshot(function):
    return {key: value_of(getattr(function, key, None)) for key in PRESERVED_FIELDS}


def _object(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError()
    return {key.lower(): item for key, item in value.items()}


def _jwt_policy(auth_type, auth_config):
    """Inspect policy in memory. Never print the JWKS or returned configuration."""
    try:
        if not isinstance(auth_type, str) or auth_type.lower() != "jwt":
            raise ValueError()
        policy = _object(auth_config)
        if set(policy) - {"jwks", "tokenlookup", "claimpassby", "whitelist", "blacklist", "matchmode", "issuer", "issuers", "audience", "audiences"}:
            raise ValueError()
        jwks = _object(policy.get("jwks"))
        keys = jwks.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 5:
            raise ValueError()
        for key in keys:
            if (not isinstance(key, dict) or key.get("kty") != "RSA" or key.get("alg") != "RS256"
                    or key.get("use") != "sig" or any(name in key for name in ("d", "p", "q", "dp", "dq", "qi", "oth", "k"))):
                raise ValueError()
            n = key.get("n", "")
            if not isinstance(n, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", n):
                raise ValueError()
            if int.from_bytes(base64.urlsafe_b64decode(n + "=" * (-len(n) % 4)), "big").bit_length() < 2048:
                raise ValueError()
        lookup = policy.get("tokenlookup")
        if isinstance(lookup, str):
            parts = lookup.split(":", 2)
            if len(parts) != 3 or "," in lookup or parts[0].lower() != "header" or parts[1].lower() != "x-jwt-token" or parts[2].strip() != "Bearer":
                raise ValueError()
        else:
            lookup = _object(lookup)
            if (lookup.get("readposition", "").lower() != "header" or lookup.get("parametername", "").lower() != "x-jwt-token"
                    or lookup.get("prefix", "").strip() != "Bearer"):
                raise ValueError()
        # This managed sync handler accepts actions independent of path. It has
        # no public health route, so every HTTP path must remain JWT protected.
        if policy.get("blacklist"):
            raise ValueError()
        whitelist = policy.get("whitelist") or []
        if not isinstance(whitelist, list):
            raise ValueError()
        if whitelist:
            raise ValueError()
        mode = policy.get("matchmode", "all")
        if not isinstance(mode, str) or mode.lower() not in ("all", "matchall", "match_all", "whitelist"):
            raise ValueError()
        if "x-jwt-token" in str(policy.get("claimpassby", "")).lower():
            raise ValueError()
        return policy
    except (ValueError, TypeError, AttributeError, KeyError):
        try:
            fields = sorted(_object(auth_config))
        except (ValueError, TypeError, AttributeError):
            fields = []
        raise DeployError("FC ingress must enforce RS256 JWT from X-JWT-Token for all sync paths; policy fields: " + ", ".join(fields)) from None


def audit_native_jwt(client, target):
    policies = []
    token = None
    seen = set()
    for _ in range(20):
        page = client.list_triggers(target["functionName"], models.ListTriggersRequest(limit=100, next_token=token)).body
        for trigger in page.triggers or []:
            if trigger.trigger_type != "http":
                continue
            trigger = client.get_trigger(target["functionName"], trigger.trigger_name).body
            config = _object(trigger.trigger_config)
            if config.get("disableurlinternet") is True:
                continue
            # The default function URL may be RAM-signature protected while the
            # CDN origin custom domain uses JWT. This is not an anonymous bypass.
            if config.get("authtype") == "function":
                policies.append({"type": "ram-trigger", "name": trigger.trigger_name, "policy": {"authType": "function"}})
                continue
            try:
                policy = _jwt_policy(config.get("authtype"), config.get("authconfig"))
            except DeployError:
                print(json.dumps({"event": "native_jwt_policy_unconfirmed", "source": "httpTrigger",
                                  "authType": config.get("authtype"), "fields": sorted(config),
                                  "authConfigType": type(config.get("authconfig")).__name__}), flush=True)
                raise
            policies.append({"type": "trigger", "name": trigger.trigger_name, "policy": policy})
        token = page.next_token
        if not token:
            break
        if token in seen:
            raise DeployError("FC trigger pagination did not complete.")
        seen.add(token)
    else:
        raise DeployError("FC trigger pagination exceeded its bound.")
    trigger_count = len(policies)
    token = None
    seen = set()
    for _ in range(20):
        page = client.list_custom_domains(models.ListCustomDomainsRequest(limit=100, next_token=token)).body
        for domain in page.custom_domains or []:
            if domain.route_config is None:
                domain = client.get_custom_domain(domain.domain_name).body
            routes = (domain.route_config.routes if domain.route_config else []) or []
            if not any(route.function_name == target["functionName"] for route in routes):
                continue
            auth = domain.auth_config
            policy = _jwt_policy(auth.auth_type if auth else None, auth.auth_info if auth else None)
            policies.append({"type": "domain", "name": domain.domain_name, "policy": policy})
        token = page.next_token
        if not token:
            break
        if token in seen:
            raise DeployError("FC custom-domain pagination did not complete.")
        seen.add(token)
    else:
        raise DeployError("FC custom-domain pagination exceeded its bound.")
    if not policies:
        raise DeployError("No protected HTTP ingress was found for the function.")
    jwt_ready = any(policy["type"] != "ram-trigger" for policy in policies)
    # A new region can be staged behind RAM authentication before its JWT
    # custom domain is attached. Never relax an anonymous ingress to do this.
    print(json.dumps({"event": "native_jwt_verified", "httpTriggers": trigger_count,
                      "ramProtectedTriggers": sum(policy["type"] == "ram-trigger" for policy in policies),
                      "customDomains": len(policies) - trigger_count, "jwtIngressReady": jwt_ready}), flush=True)
    if not jwt_ready:
        print("Deployment is staged behind RAM authentication. Configure a JWT-protected custom domain before switching CDN traffic.", flush=True)
    return hashlib.sha256(json.dumps(policies, sort_keys=True).encode()).hexdigest()


def deploy(client, target, package, *, sleep=time.sleep, now=time.monotonic):
    name = target["functionName"]
    # Do not create or overwrite a function with an unexpected runtime/handler.
    current = client.get_function(name, models.GetFunctionRequest()).body
    if current.runtime != target["runtime"] or current.handler != target["handler"]:
        raise DeployError("Existing runtime/handler differs from s.yaml; deployment stopped before writing.")
    ingress_before = audit_native_jwt(client, target)
    before = snapshot(current)
    checksum = crc64(package)
    print(json.dumps({"event": "fc_preflight", "state": current.state,
                      "lastUpdateStatus": current.last_update_status, "expectedCodeChecksum": checksum}), flush=True)
    body = models.UpdateFunctionInput(
        code=models.InputCodeLocation(zip_file=base64.b64encode(package).decode("ascii"), checksum=checksum),
        timeout=target["timeout"],
    )
    # Deliberately omit environmentVariables, role and all other properties.
    client.update_function_with_options(
        name, models.UpdateFunctionRequest(body=body), {},
        RuntimeOptions(connect_timeout=60000, read_timeout=180000, autoretry=False),
    )
    print("FC accepted the code update; reading back deployment state.", flush=True)
    deadline = now() + 180
    previous_status = None
    while now() < deadline:
        deployed = client.get_function(name, models.GetFunctionRequest()).body
        status = {"state": deployed.state, "lastUpdateStatus": deployed.last_update_status,
                  "codeChecksum": str(deployed.code_checksum), "checksumMatches": str(deployed.code_checksum) == checksum}
        if status != previous_status:
            print(json.dumps({"event": "fc_verification", **status}), flush=True)
            previous_status = status
        if deployed.state == "Failed" or deployed.last_update_status == "Failed":
            raise DeployError("FC reports a failed update; inspect the FC console for the reason.")
        # Some ordinary CPU functions omit the container-oriented state fields.
        # In that case the code checksum and runtime/config readback remain required.
        if (deployed.state in (None, "", "Active") and deployed.last_update_status in (None, "", "Successful")
                and str(deployed.code_checksum) == checksum):
            if deployed.runtime != target["runtime"] or deployed.handler != target["handler"] or deployed.timeout != target["timeout"]:
                raise DeployError("Deployed runtime/handler/timeout verification failed.")
            if snapshot(deployed) != before:
                raise DeployError("FC configuration changed during deployment; inspect the console before continuing.")
            if audit_native_jwt(client, target) != ingress_before:
                raise DeployError("FC JWT ingress policy changed during deployment; inspect the console.")
            return {
                "functionName": name, "region": target["region"], "runtime": deployed.runtime,
                "handler": deployed.handler, "timeout": deployed.timeout,
                "codeChecksum": checksum, "zipSha256": hashlib.sha256(package).hexdigest(),
                "codeSize": deployed.code_size, "sourceCommit": os.environ.get("GITHUB_SHA", "local"),
            }
        sleep(5)
    raise DeployError("FC update verification timed out; inspect fc_verification status above before retrying.")


def main():
    root = Path(__file__).resolve().parents[1]
    target = target_from_yaml(root / "s.yaml")
    package = load_zip(root / target["code"])
    credentials = [os.environ.get(key, "").strip() for key in ("ALIYUN_FC_ACCESS_KEY_ID", "ALIYUN_FC_ACCESS_KEY_SECRET")]
    if not all(credentials):
        raise DeployError("Configure Repository secrets ALIYUN_FC_ACCESS_KEY_ID and ALIYUN_FC_ACCESS_KEY_SECRET.")
    config = Config(access_key_id=credentials[0], access_key_secret=credentials[1],
                    endpoint=f"fcv3.{target['region']}.aliyuncs.com", connect_timeout=60000, read_timeout=180000)
    print(f"Deploying {target['functionName']} in {target['region']}; updating code and timeout only.")
    result = deploy(Client(config), target, package)
    (root / "dist/deploy-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write("## FC deployment verified\n\n")
            for key, value in result.items():
                output.write(f"- {key}: `{value}`\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except DeployError as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Alibaba SDK exceptions can contain request bodies, signed URLs or envs.
        code = getattr(error, "code", "")
        code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code) else type(error).__name__
        causes = []
        for name in ("inner_exception", "cause", "last_exception", "__cause__"):
            value = getattr(error, name, None)
            if value is not None:
                causes.append(type(value).__name__)
        text = str(error).lower()
        hints = [name for name in ("timeout", "timed out", "connection reset", "connection refused", "broken pipe", "name resolution") if name in text]
        print(f"Deployment failed ({code}); cause types: {','.join(causes) or 'unavailable'}; network hints: {','.join(hints) or 'none'}. Check FC permissions and GitHub Actions network access.", file=sys.stderr)
        sys.exit(1)
