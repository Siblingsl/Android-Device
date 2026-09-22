"""Exercise runtime configuration and rollback without a Docker daemon."""
import copy
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

# Some interpreters (e.g. AutoClaw's bundled Python 3.13) start with
# safe_path=True (the -P flag / PYTHONSAFEPATH environment variable), which keeps
# both the script's own directory and PYTHONPATH out of sys.path — so a plain
# `python test_qemu_guest.py` cannot import its sibling module. Bootstrap the
# directory explicitly to keep this file runnable under any interpreter.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import qemu_guest as guest  # noqa: E402


FIXTURE = {
    "Config": {"Image": "old", "Hostname": "original", "Cmd": ["androidboot.redroid_width=720"],
               "Env": ["KEEP=yes"], "Labels": {"owner": "user"}},
    "HostConfig": {"Binds": ["qc-r1-data:/data", "/keep:/keep:ro"],
                   "PortBindings": {"5555/tcp": [{"HostIp": "0.0.0.0", "HostPort": "24500"}]},
                   "Memory": 2147483648, "NanoCpus": 1000000000, "Privileged": True,
                   "RestartPolicy": {"Name": "unless-stopped"}, "NetworkMode": "bridge"},
    "Mounts": [{"Type": "volume", "Name": "qc-r1-data", "Destination": "/data", "RW": True}],
    "State": {"Running": True},
}


class ConfigTests(unittest.TestCase):
    def test_runner_rejects_unsafe_request_fields_at_the_guest_boundary(self):
        with self.assertRaisesRegex(ValueError, "module"):
            guest.validate_runner_request({"action": "seed", "moduleIds": ["../escape"]})
        with self.assertRaisesRegex(ValueError, "property"):
            guest.validate_runner_request({"action": "activate", "expectedProps": {"ro.build.sdk;id": "34"}})

    def test_runner_requires_context_to_stay_inside_the_current_job(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = guest.Path(root)
            request_path = root_path / "job-a" / "request.json"
            with patch.object(guest, "EXECUTION_AUTHORIZATION_ROOT", root), \
                    self.assertRaisesRegex(ValueError, "context"):
                guest.validate_runner_request(
                    {"action": "build", "context": str(root_path / "job-b"),
                     "baseImage": "redroid/redroid@sha256:" + "0" * 64},
                    request_path,
                )

    def test_runner_rejects_oversized_request_files(self):
        with tempfile.NamedTemporaryFile("wb", delete=False) as request:
            request.write(b"x" * (guest.MAX_REQUEST_BYTES + 1))
            path = request.name
        try:
            with self.assertRaisesRegex(ValueError, "request.*large"):
                guest.read_bounded_request(path)
        finally:
            os.unlink(path)

    def test_runner_rejects_oversized_subprocess_output(self):
        with patch.object(guest, "MAX_SUBPROCESS_OUTPUT_BYTES", 1024), \
                self.assertRaisesRegex(ValueError, "output"):
            guest.run_bounded_subprocess(
                [sys.executable, "-c", "print('x' * 2048)"],
                timeout=10,
            )

    def test_runner_rejects_requests_without_a_signed_execution_grant(self):
        with self.assertRaisesRegex(ValueError, "execution grant"):
            guest.verify_execution_grant(
                {"action": "build", "vm": "node1", "name": "r13"},
                "preset_apply",
                "node1",
                "r13",
            )

    def test_runner_rejects_execution_grants_without_device_proof(self):
        claims = {
            "iss": "rdc-auth", "aud": "rdc-guest-runner", "client_id": "client-a",
            "device_id": "device-a", "session_id": "session-a", "client_version": "1.0.0",
            "artifact_id": "core-a",
            "artifact_sha256": guest.hashlib.sha256(guest.Path(guest.__file__).read_bytes()).hexdigest(),
            "action": "preset_apply", "vm": "node1", "instance": "r13",
            "iat": int(guest.time.time()) - 1, "exp": int(guest.time.time()) + 60,
            "jti": "grant-without-device-proof", "nonce": "nonce-without-device-proof",
        }
        payload = guest.json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()
        request = {
            "action": "build", "vm": "node1", "name": "r13", "executionInstance": "r13",
            "executionGrant": {
                "key_id": "test-key",
                "payload": guest.base64.urlsafe_b64encode(payload).decode().rstrip("="),
                "signature": guest.base64.urlsafe_b64encode(b"s" * 64).decode().rstrip("="),
            },
        }
        with patch.object(guest, "EXECUTION_GRANT_KEY_ID", "test-key"), \
                patch.object(guest, "EXECUTION_GRANT_PUBLIC_KEY", guest.base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")), \
                patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(ValueError, "device proof"):
                guest.verify_execution_grant(request, "preset_apply", "node1", "r13")

    def test_runner_checks_the_signed_workflow_and_vm_binding(self):
        claims = {
            "iss": "rdc-auth", "aud": "rdc-guest-runner", "client_id": "client-a",
            "device_id": "device-a", "session_id": "session-a", "client_version": "1.0.0",
            "artifact_id": "core-a",
            "artifact_sha256": guest.hashlib.sha256(guest.Path(guest.__file__).read_bytes()).hexdigest(),
            "action": "preset_apply", "vm": "node1", "instance": "r13",
            "iat": int(guest.time.time()) - 1, "exp": int(guest.time.time()) + 60,
            "jti": "grant-a", "nonce": "nonce-a",
        }
        payload = guest.json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()
        request = {
            "action": "build", "vm": "node1", "name": "r13", "executionInstance": "r13",
            "executionGrant": {
                "key_id": "test-key",
                "payload": guest.base64.urlsafe_b64encode(payload).decode().rstrip("="),
                "signature": guest.base64.urlsafe_b64encode(b"s" * 64).decode().rstrip("="),
                "device_proof": "proof-a",
            },
        }
        with patch.object(guest, "EXECUTION_GRANT_KEY_ID", "test-key"), \
                patch.object(guest, "EXECUTION_GRANT_PUBLIC_KEY", guest.base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")), \
                patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            self.assertEqual(
                guest.verify_execution_grant(request, "preset_apply", "node1", "r13")["jti"],
                "grant-a",
            )
            with self.assertRaisesRegex(ValueError, "another operation"):
                guest.verify_execution_grant(request, "preset_apply", "node2", "r13")

    def test_runner_rejects_a_tampered_execution_grant_signature(self):
        claims = {
            "iss": "rdc-auth", "aud": "rdc-guest-runner", "client_id": "client-a",
            "device_id": "device-a", "session_id": "session-a", "client_version": "1.0.0",
            "artifact_id": "core-a",
            "artifact_sha256": guest.hashlib.sha256(guest.Path(guest.__file__).read_bytes()).hexdigest(),
            "action": "preset_apply", "vm": "node1", "instance": "r13",
            "iat": int(guest.time.time()) - 1, "exp": int(guest.time.time()) + 60,
            "jti": "grant-tampered", "nonce": "nonce-tampered",
        }
        payload = guest.json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()
        request = {
            "action": "build", "vm": "node1", "name": "r13", "executionInstance": "r13",
            "executionGrant": {
                "key_id": "test-key",
                "payload": guest.base64.urlsafe_b64encode(payload).decode().rstrip("="),
                "signature": guest.base64.urlsafe_b64encode(b"t" * 64).decode().rstrip("="),
                "device_proof": "proof-tampered",
            },
        }
        with patch.object(guest, "EXECUTION_GRANT_KEY_ID", "test-key"), \
                patch.object(guest, "EXECUTION_GRANT_PUBLIC_KEY", guest.base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")), \
                patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(ValueError, "signature is invalid"):
                guest.verify_execution_grant(request, "preset_apply", "node1", "r13")

    def test_runner_rejects_a_grant_for_a_different_core_artifact(self):
        claims = {
            "iss": "rdc-auth", "aud": "rdc-guest-runner", "client_id": "client-a",
            "device_id": "device-a", "session_id": "session-a", "client_version": "1.0.0",
            "artifact_id": "core-a", "artifact_sha256": "0" * 64,
            "action": "preset_apply", "vm": "node1", "instance": "r13",
            "iat": int(guest.time.time()) - 1, "exp": int(guest.time.time()) + 60,
            "jti": "grant-other-artifact", "nonce": "nonce-other-artifact",
        }
        payload = guest.json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()
        request = {
            "action": "build", "vm": "node1", "name": "r13", "executionInstance": "r13",
            "executionGrant": {
                "key_id": "test-key",
                "payload": guest.base64.urlsafe_b64encode(payload).decode().rstrip("="),
                "signature": guest.base64.urlsafe_b64encode(b"s" * 64).decode().rstrip("="),
                "device_proof": "proof-other-artifact",
            },
        }
        with patch.object(guest, "EXECUTION_GRANT_KEY_ID", "test-key"), \
                patch.object(guest, "EXECUTION_GRANT_PUBLIC_KEY", guest.base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")), \
                patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(ValueError, "another core artifact"):
                guest.verify_execution_grant(request, "preset_apply", "node1", "r13")

    def test_runner_rejects_a_tampered_runner_file(self):
        original_path = guest.Path(guest.__file__)
        original_hash = guest.hashlib.sha256(original_path.read_bytes()).hexdigest()
        claims = {
            "iss": "rdc-auth", "aud": "rdc-guest-runner", "client_id": "client-a",
            "device_id": "device-a", "session_id": "session-a", "client_version": "1.0.0",
            "artifact_id": "core-a", "artifact_sha256": original_hash,
            "action": "preset_apply", "vm": "node1", "instance": "r13",
            "iat": int(guest.time.time()) - 1, "exp": int(guest.time.time()) + 60,
            "jti": "grant-tampered-runner", "nonce": "nonce-tampered-runner",
        }
        payload = guest.json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode()
        request = {
            "action": "build", "vm": "node1", "name": "r13", "executionInstance": "r13",
            "executionGrant": {
                "key_id": "test-key",
                "payload": guest.base64.urlsafe_b64encode(payload).decode().rstrip("="),
                "signature": guest.base64.urlsafe_b64encode(b"s" * 64).decode().rstrip("="),
                "device_proof": "proof-tampered-runner",
            },
        }
        with tempfile.NamedTemporaryFile("wb", delete=False) as tampered:
            tampered.write(original_path.read_bytes() + b"\n# tampered")
            tampered_path = tampered.name
        try:
            with patch.object(guest, "__file__", tampered_path), \
                    patch.object(guest, "EXECUTION_GRANT_KEY_ID", "test-key"), \
                    patch.object(guest, "EXECUTION_GRANT_PUBLIC_KEY",
                                 guest.base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")), \
                    patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                with self.assertRaisesRegex(ValueError, "another core artifact"):
                    guest.verify_execution_grant(request, "preset_apply", "node1", "r13")
        finally:
            os.unlink(tampered_path)

    def test_runner_consumes_a_grant_before_protected_work(self):
        grant = {
            "key_id": "test-key",
            "payload": "payload",
            "signature": "signature",
            "device_proof": "proof-a",
        }

        class Response:
            status = 200

            def read(self, amount=-1):
                return b'{"key_id":"test-key","payload":"receipt-payload","signature":"receipt-signature"}'

        class Connection:
            requests = []

            def __init__(self, host, port, timeout):
                self.host = host
                self.port = port
                self.timeout = timeout

            def request(self, method, path, body, headers):
                self.requests.append((method, path, body, headers))

            def getresponse(self):
                return Response()

            def close(self):
                pass

        with patch.object(guest, "EXECUTION_GRANT_CONSUME_URL",
                          "https://auth.example/v1/execution-grants/consume"), \
                patch.object(guest.http.client, "HTTPSConnection", Connection):
            receipt = guest.consume_execution_grant(grant)

        self.assertEqual(Connection.requests[0][0], "POST")
        self.assertEqual(Connection.requests[0][1], "/v1/execution-grants/consume")
        self.assertIn(b'"key_id":"test-key"', Connection.requests[0][2])
        self.assertEqual(receipt["key_id"], "test-key")

    def test_runner_rejects_a_grant_rejected_as_already_consumed(self):
        class Response:
            status = 409

            def read(self):
                return b""

        class Connection:
            def __init__(self, host, port, timeout):
                pass

            def request(self, method, path, body, headers):
                pass

            def getresponse(self):
                return Response()

            def close(self):
                pass

        with patch.object(guest, "EXECUTION_GRANT_CONSUME_URL",
                          "https://auth.example/v1/execution-grants/consume"), \
                patch.object(guest.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "already been consumed"):
                guest.consume_execution_grant({
                    "key_id": "test-key", "payload": "payload", "signature": "signature",
                    "device_proof": "proof-a",
                })

    def test_runner_rejects_an_oversized_consume_response(self):
        class Response:
            status = 200

            def read(self, amount=-1):
                return b"x" * (guest.MAX_EXECUTION_CONSUME_RESPONSE_BYTES + 1)

        class Connection:
            def __init__(self, host, port, timeout):
                pass

            def request(self, method, path, body, headers):
                pass

            def getresponse(self):
                return Response()

            def close(self):
                pass

        with patch.object(guest, "EXECUTION_GRANT_CONSUME_URL",
                          "https://auth.example/v1/execution-grants/consume"), \
                patch.object(guest.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "too large"):
                guest.consume_execution_grant({
                    "key_id": "test-key", "payload": "payload", "signature": "signature",
                    "device_proof": "proof-a",
                })

    def test_runner_fails_closed_when_the_consume_service_is_unreachable(self):
        class Connection:
            def __init__(self, host, port, timeout):
                raise OSError("offline")

        with patch.object(guest, "EXECUTION_GRANT_CONSUME_URL",
                          "https://auth.example/v1/execution-grants/consume"), \
                patch.object(guest.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "unavailable"):
                guest.consume_execution_grant({
                    "key_id": "test-key", "payload": "payload", "signature": "signature",
                    "device_proof": "proof-a",
                })

    def test_main_never_constructs_docker_when_grant_consumption_fails(self):
        request = {
            "action": "details",
            "vm": "node1",
            "executionInstance": "r13",
            "executionGrant": {"key_id": "test-key"},
        }
        with patch.dict(sys.modules, {"fcntl": SimpleNamespace()}), \
                patch.object(guest, "verify_execution_grant", return_value={"jti": "grant-a"}), \
                patch.object(guest, "consume_execution_grant",
                             side_effect=ValueError("consume service unavailable")), \
                patch.object(guest, "Docker", side_effect=AssertionError("Docker must not be constructed")):
            with self.assertRaisesRegex(ValueError, "unavailable"):
                guest.main(request)

    def test_authorize_action_consumes_then_writes_a_one_time_marker(self):
        with tempfile.TemporaryDirectory() as root:
            marker = os.path.join(root, "job", "execution-authorized")
            os.makedirs(os.path.dirname(marker))
            request = {
                "action": "authorize",
                "vm": "node1",
                "executionInstance": "r13",
                "executionAuthorizationPath": marker,
                "executionGrant": {"key_id": "test-key"},
            }
            receipt = {"key_id": "test-key", "payload": "receipt-payload", "signature": "receipt-signature"}
            with patch.object(guest, "verify_execution_grant",
                              return_value={"jti": "grant-a"}), \
                    patch.object(guest, "consume_execution_grant", return_value=receipt) as consume, \
                    patch.object(guest, "_verify_execution_authorization_receipt", return_value={}), \
                    patch.object(guest, "EXECUTION_AUTHORIZATION_ROOT", root), \
                    patch.object(guest, "Docker", side_effect=AssertionError("Docker must not be constructed")):
                guest.main(request)
            consume.assert_called_once_with(request["executionGrant"])
            with open(marker, encoding="utf-8") as stream:
                self.assertEqual(guest.json.loads(stream.read()), receipt)

    def test_activate_action_requires_the_matching_preflight_marker(self):
        with tempfile.TemporaryDirectory() as root:
            marker = os.path.join(root, "job", "execution-authorized")
            os.makedirs(os.path.dirname(marker))
            request = {
                "action": "activate",
                "vm": "node1",
                "executionInstance": "r13",
                "executionAuthorizationPath": marker,
                "executionGrant": {"key_id": "test-key"},
            }
            with patch.object(guest, "verify_execution_grant",
                              return_value={"jti": "grant-a"}), \
                    patch.object(guest, "Docker", side_effect=AssertionError("Docker must not be constructed")), \
                    patch.object(guest, "EXECUTION_AUTHORIZATION_ROOT", root):
                with self.assertRaisesRegex(ValueError, "authorization marker"):
                    guest.main(request)

    def test_preflight_marker_is_single_use_and_binds_the_grant_jti(self):
        with tempfile.TemporaryDirectory() as root:
            marker = os.path.join(root, "job", "execution-authorized")
            os.makedirs(os.path.dirname(marker))
            request = {"executionAuthorizationPath": marker}
            claims = {"jti": "grant-a"}
            receipt = {"key_id": "test-key", "payload": "receipt-payload", "signature": "receipt-signature"}
            with patch.object(guest, "EXECUTION_AUTHORIZATION_ROOT", root):
                with patch.object(guest, "_verify_execution_authorization_receipt", return_value={}):
                    guest.write_execution_authorization_marker(request, claims, receipt)
                    guest.require_execution_authorization_marker(request, claims)
                with patch.object(guest, "_verify_execution_authorization_receipt", return_value={}):
                    with self.assertRaisesRegex(ValueError, "already exists"):
                        guest.write_execution_authorization_marker(request, claims, receipt)
                with open(marker, "w") as stream:
                    stream.write("grant-b")
                with self.assertRaisesRegex(ValueError, "signed receipt"):
                    guest.require_execution_authorization_marker(request, claims)

    def test_jti_only_preflight_marker_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            marker = os.path.join(root, "job", "execution-authorized")
            os.makedirs(os.path.dirname(marker))
            with open(marker, "w", encoding="utf-8") as stream:
                stream.write("grant-a")
            with patch.object(guest, "EXECUTION_AUTHORIZATION_ROOT", root):
                with self.assertRaisesRegex(ValueError, "signed receipt"):
                    guest.require_execution_authorization_marker(
                        {"executionAuthorizationPath": marker},
                        {"jti": "grant-a"},
                    )

    def test_upgrade_clones_data_and_keeps_ports_resources_command_and_other_mounts(self):
        original = copy.deepcopy(FIXTURE)
        result = guest.clone_config(original, "new", "qc-r1-data", "clone-data")
        self.assertEqual(result["HostConfig"]["Binds"], ["clone-data:/data", "/keep:/keep:ro"])
        self.assertEqual(result["HostConfig"]["PortBindings"],
                         {"5555/tcp": [{"HostIp": "0.0.0.0", "HostPort": "24500"}]})
        self.assertEqual(result["HostConfig"]["Memory"], 2147483648)
        self.assertEqual(result["HostConfig"]["NanoCpus"], 1000000000)
        self.assertEqual(result["Cmd"], ["androidboot.redroid_width=720"])
        self.assertEqual(result["Env"], ["KEEP=yes"])
        self.assertEqual(result["Image"], "new")
        self.assertEqual(original, FIXTURE)

    def test_unmanaged_data_mount_is_rejected(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture["Mounts"][0]["Type"] = "bind"
        with self.assertRaisesRegex(ValueError, "volume"):
            guest.data_volume(fixture)

    def test_version_guard_uses_sdk_instead_of_spoofable_release(self):
        self.assertEqual(guest.android_version("ro.build.version.sdk=34\nro.build.version.release=13\n"), "14")
        with self.assertRaisesRegex(ValueError, "SDK"):
            guest.android_version("ro.build.version.release=14\n")

    def test_runtime_metrics_preserve_limits_size_and_timestamps(self):
        inspected = {
            "HostConfig": {"NanoCpus": 2_000_000_000, "Memory": 4_294_967_296},
            "SizeRw": 1_048_576,
            "State": {
                "StartedAt": "2026-09-16T10:00:00.000000000Z",
                "FinishedAt": "2026-09-16T10:01:00.000000000Z",
            },
        }
        self.assertEqual(guest.runtime_metrics(inspected), {
            "cpuQuotaCores": 2.0,
            "cpuUnlimited": False,
            "memoryQuotaBytes": 4_294_967_296,
            "memoryUnlimited": False,
            "diskBytes": 1_048_576,
            "startedAt": "2026-09-16T10:00:00.000000000Z",
            "finishedAt": "2026-09-16T10:01:00.000000000Z",
        })

    def test_runtime_metrics_keep_unlimited_distinct_from_missing(self):
        self.assertEqual(guest.runtime_metrics({
            "HostConfig": {"NanoCpus": 0, "Memory": 0},
            "SizeRw": 0,
            "State": {"StartedAt": "0001-01-01T00:00:00Z", "FinishedAt": "0001-01-01T00:00:00Z"},
        }), {
            "cpuQuotaCores": None,
            "cpuUnlimited": True,
            "memoryQuotaBytes": None,
            "memoryUnlimited": True,
            "diskBytes": 0,
            "startedAt": None,
            "finishedAt": None,
        })
        self.assertIsNone(guest.runtime_metrics({}))

    def test_wrong_target_version_never_stops_current_instance(self):
        docker = FakeDocker()
        with patch.object(guest, "image_version", return_value="13"), \
             patch.object(guest, "device_version", return_value="14"):
            with self.assertRaisesRegex(ValueError, "Android"):
                guest.upgrade(docker, {"name": "r1", "image": "new"})
        self.assertEqual(docker.events, [])

    def test_activation_failure_restores_old_container_and_original_data(self):
        docker = FakeDocker()
        with patch.object(guest, "image_version", return_value="14"), \
             patch.object(guest, "device_version", return_value="14"), \
             patch.object(guest, "clone_volume", return_value=None), \
             patch.object(guest, "seed_data", return_value=None), \
             patch.object(guest, "activate", side_effect=RuntimeError("module activation failed")):
            with self.assertRaisesRegex(RuntimeError, "restored"):
                guest.upgrade(docker, {"name": "r1", "image": "new"})
        self.assertEqual(docker.containers["qc-r1"]["Config"]["Image"], "old")
        self.assertEqual(docker.containers["qc-r1"]["HostConfig"]["Binds"][0], "qc-r1-data:/data")
        self.assertTrue(docker.containers["qc-r1"]["State"]["Running"])


class FakeDocker:
    def __init__(self):
        self.containers = {"qc-r1": copy.deepcopy(FIXTURE)}
        self.events = []

    def inspect(self, name):
        return copy.deepcopy(self.containers[name])

    def exists(self, name):
        return name in self.containers

    def stop(self, name):
        self.events.append(("stop", name))
        self.containers[name]["State"]["Running"] = False

    def start(self, name):
        self.events.append(("start", name))
        self.containers[name]["State"]["Running"] = True

    def rename(self, old, new):
        self.events.append(("rename", old, new))
        self.containers[new] = self.containers.pop(old)

    def update_restart(self, name, policy):
        self.containers[name]["HostConfig"]["RestartPolicy"] = copy.deepcopy(policy)

    def create(self, name, config):
        self.containers[name] = {"Config": {k: v for k, v in config.items() if k != "HostConfig"},
                                 "HostConfig": config["HostConfig"], "State": {"Running": False}}

    def remove(self, name):
        self.containers.pop(name, None)


if __name__ == "__main__":
    unittest.main()
