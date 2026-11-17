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
            required = {"index.js", "package.json", "src/sync.js", "node_modules/ali-oss/package.json"}
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


def deploy(client, target, package, *, sleep=time.sleep, now=time.monotonic):
    name = target["functionName"]
    # Do not create or overwrite a function with an unexpected runtime/handler.
    current = client.get_function(name, models.GetFunctionRequest()).body
    if current.runtime != target["runtime"] or current.handler != target["handler"]:
        raise DeployError("Existing runtime/handler differs from s.yaml; deployment stopped before writing.")
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
        RuntimeOptions(connect_timeout=10000, read_timeout=120000, autoretry=False),
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
                    endpoint=f"fcv3.{target['region']}.aliyuncs.com", connect_timeout=10000, read_timeout=120000)
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
        print(f"Deployment failed ({code}); check FC permissions and GitHub Actions network access.", file=sys.stderr)
        sys.exit(1)
