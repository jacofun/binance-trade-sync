import base64
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
import zipfile

from alibabacloud_fc20230330 import models
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy_fc", ROOT / "scripts/deploy_fc.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeClient:
    def __init__(self, *, wrong_runtime=False, change_env=False, failed=False, mismatch=False, omit_state=False, policy=None):
        self.wrong_runtime = wrong_runtime
        self.change_env = change_env
        self.failed = failed
        self.mismatch = mismatch
        self.omit_state = omit_state
        self.updated = False
        self.request = None
        self.policy = policy or {"authType": "function"}

    def list_triggers(self, name, request):
        return SimpleNamespace(body=models.ListTriggersOutput(triggers=[models.Trigger(trigger_type="http", trigger_name="defaultTrigger")]))

    def get_trigger(self, name, trigger_name):
        return SimpleNamespace(body=models.Trigger(trigger_type="http", trigger_name=trigger_name, trigger_config=json.dumps(self.policy)))

    def list_custom_domains(self, request):
        return SimpleNamespace(body=models.ListCustomDomainOutput(custom_domains=[]))

    def get_function(self, name, request):
        env = {"BINANCE_API_SECRET": "must-remain-private", "OSS_BUCKET": "existing-bucket"}
        if self.change_env and self.updated:
            env = {}
        function = models.Function(
            runtime="python3.10" if self.wrong_runtime else "nodejs20", handler="index.handler",
            state="Failed" if self.failed and self.updated else "Active", last_update_status="Successful",
            timeout=300 if self.updated else 60, code_size=123,
            code_checksum=("999" if self.mismatch else self.request.body.code.checksum) if self.updated else "old",
            environment_variables=env, cpu=0.35, memory_size=512, disk_size=10240,
            role="existing-role", internet_access=True,
            vpc_config=models.VPCConfig(vpc_id="preserved-vpc"),
        )
        if self.omit_state:
            function.state = None
            function.last_update_status = None
        return SimpleNamespace(body=function)

    def update_function_with_options(self, name, request, headers, runtime):
        self.request = request
        self.updated = True
        assert runtime.autoretry is False
        return SimpleNamespace(body=None)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.target = module.target_from_yaml(ROOT / "s.yaml")

    def test_crc64_standard_vector(self):
        self.assertEqual(module.crc64(b"123456789"), str(0x995DC9BBDF1939FA))
        self.assertEqual(module.crc64(b""), "0")

    def test_only_code_and_timeout_are_sent_and_configuration_is_preserved(self):
        client = FakeClient()
        result = module.deploy(client, self.target, b"zip-bytes", sleep=lambda _: None)
        payload = client.request.body.to_map()
        self.assertEqual(set(payload), {"code", "timeout"})
        self.assertEqual(base64.b64decode(payload["code"]["zipFile"]), b"zip-bytes")
        self.assertEqual(result["timeout"], 300)
        self.assertNotIn("must-remain-private", str(result))

    def test_mismatched_runtime_stops_before_update(self):
        client = FakeClient(wrong_runtime=True)
        with self.assertRaisesRegex(module.DeployError, "before writing"):
            module.deploy(client, self.target, b"zip")
        self.assertFalse(client.updated)

    def test_environment_drift_is_detected_without_printing_values(self):
        with self.assertRaisesRegex(module.DeployError, "configuration changed") as error:
            module.deploy(FakeClient(change_env=True), self.target, b"zip")
        self.assertNotIn("must-remain-private", str(error.exception))

    def test_cloud_failure_is_not_reported_as_success(self):
        with self.assertRaisesRegex(module.DeployError, "failed update"):
            module.deploy(FakeClient(failed=True), self.target, b"zip")

    def test_cpu_function_can_omit_container_state_fields_but_still_needs_matching_code(self):
        result = module.deploy(FakeClient(omit_state=True), self.target, b"zip")
        self.assertEqual(result["codeChecksum"], module.crc64(b"zip"))

    def test_checksum_mismatch_cannot_pass_verification(self):
        ticks = iter([0, 1, 181])
        with self.assertRaisesRegex(module.DeployError, "timed out"):
            module.deploy(FakeClient(mismatch=True), self.target, b"zip", sleep=lambda _: None, now=lambda: next(ticks))

    def test_workflow_runs_on_main_and_uses_only_existing_secret_names(self):
        # BaseLoader keeps the YAML 1.2 GitHub 'on' key as a string.
        workflow = yaml.load((ROOT / ".github/workflows/deploy-fc.yml").read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        self.assertIn("workflow_dispatch", workflow["on"])
        self.assertEqual(workflow["concurrency"]["cancel-in-progress"], "false")
        step = workflow["jobs"]["deploy"]["steps"][-1]
        self.assertEqual(set(step["env"]), {"ALIYUN_FC_ACCESS_KEY_ID", "ALIYUN_FC_ACCESS_KEY_SECRET"})
        self.assertIn("steps.current.outputs.deploy", step["if"])

    def test_anonymous_ingress_cannot_deploy_without_local_jwks(self):
        client = FakeClient(policy={"authType": "anonymous"})
        with self.assertRaises(module.DeployError):
            module.deploy(client, self.target, b"zip")
        self.assertFalse(client.updated)

    def test_native_jwt_must_read_only_the_shared_header_without_business_bypasses(self):
        modulus = base64.urlsafe_b64encode(bytes([128]) + bytes([1]) * 255).decode().rstrip("=")
        policy = {"jwks": {"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "e": "AQAB", "n": modulus}]},
                  "tokenLookup": "header:X-JWT-Token:Bearer "}
        self.assertTrue(module._jwt_policy("jwt", policy))
        for change in [{"whitelist": ["/health"]}, {"whitelist": ["/trade/api/signal/health"]}, {"whitelist": ["/trade/api/sync"]}, {"blacklist": ["/trade/api/sync"]},
                       {"tokenLookup": "header:Authorization:Bearer "}]:
            with self.assertRaises(module.DeployError):
                module._jwt_policy("jwt", {**policy, **change})

    def test_zip_requires_dependencies_and_rejects_secret_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "code.zip"
            def write_zip(extra):
                with zipfile.ZipFile(path, "w") as archive:
                    for name in ["index.js", "package.json", "src/sync.js", "src/auth.js", "node_modules/ali-oss/package.json"] + extra:
                        archive.writestr(name, "test")
            write_zip([])
            self.assertTrue(module.load_zip(path))
            write_zip([".env"])
            with self.assertRaisesRegex(module.DeployError, "forbidden"):
                module.load_zip(path)


if __name__ == "__main__":
    unittest.main()
