"""Tests for the guest-only protected-core loader."""
import base64
import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import qemu_loader as loader  # noqa: E402


def encoded(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


class Response:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    def read(self, amount=-1):
        return self._body


class Connection:
    response = None
    requests = []

    def __init__(self, host, port, timeout, context=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.context = context

    def request(self, method, path, body, headers):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return self.response

    def close(self):
        pass


class LoaderTests(unittest.TestCase):
    def setUp(self):
        Connection.requests = []

    def grant_for(self, content):
        digest = hashlib.sha256(content).hexdigest()
        claims = {"artifact_id": "qemu-guest-script", "artifact_sha256": digest}
        return {
            "key_id": "test-key",
            "payload": encoded(json.dumps(claims, separators=(",", ":")).encode()),
            "signature": "signature",
            "device_proof": "device-proof",
        }

    def release_body(self, content, artifact_sha256=None):
        return json.dumps({
            "artifact_id": "qemu-guest-script",
            "artifact_sha256": artifact_sha256 or hashlib.sha256(content).hexdigest(),
            "artifact_size_bytes": len(content),
            "content_base64": encoded(content),
        }).encode()

    def test_release_rejection_does_not_create_a_core(self):
        content = b"runner"
        Connection.response = Response(403, b'{"code":"revoked"}')
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(loader, "EXECUTION_RELEASE_URL", "https://auth.example/release"), \
                patch.object(loader.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "release request was rejected"):
                loader.release_core({"executionGrant": self.grant_for(content)}, Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_loader_rejects_oversized_request_files(self):
        with tempfile.NamedTemporaryFile("wb", delete=False) as request:
            request.write(b"x" * (loader.MAX_REQUEST_BYTES + 1))
            path = request.name
        try:
            with self.assertRaisesRegex(ValueError, "request.*large"):
                loader.read_bounded_request(path)
        finally:
            os.unlink(path)

    def test_release_rejects_a_response_with_a_different_hash(self):
        content = b"runner"
        Connection.response = Response(200, self.release_body(content, "0" * 64))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(loader, "EXECUTION_RELEASE_URL", "https://auth.example/release"), \
                patch.object(loader.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "artifact hash"):
                loader.release_core({"executionGrant": self.grant_for(content)}, Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_release_rejects_content_that_does_not_match_the_grant(self):
        expected = b"expected runner"
        tampered = b"tampered runner"
        Connection.response = Response(200, self.release_body(tampered))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(loader, "EXECUTION_RELEASE_URL", "https://auth.example/release"), \
                patch.object(loader.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "artifact hash"):
                loader.release_core(
                    {"executionGrant": self.grant_for(expected)},
                    Path(directory),
                )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_release_rejects_an_oversized_response_before_staging(self):
        Connection.response = Response(200, b"x" * (loader.MAX_RELEASE_RESPONSE_BYTES + 1))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(loader, "EXECUTION_RELEASE_URL", "https://auth.example/release"), \
                patch.object(loader.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "response is too large"):
                loader.release_core(
                    {"executionGrant": self.grant_for(b"runner")},
                    Path(directory),
                )
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_release_writes_the_verified_core_inside_guest_work_directory(self):
        content = b"server-delivered runner"
        Connection.response = Response(200, self.release_body(content))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(loader, "EXECUTION_RELEASE_URL", "https://auth.example/release"), \
                patch.object(loader.http.client, "HTTPSConnection", Connection):
            path = loader.release_core(
                {"executionGrant": self.grant_for(content)},
                Path(directory),
            )
            self.assertEqual(path.read_bytes(), content)
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            method, request_path, body, headers = Connection.requests[-1]
            self.assertEqual((method, request_path), ("POST", "/release"))
            self.assertEqual(json.loads(body)["grant"]["device_proof"], "device-proof")
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_run_request_reports_failure_to_remove_the_protected_core(self):
        with tempfile.TemporaryDirectory() as directory:
            request_path = Path(directory) / "request.json"
            request_path.write_text("{}", encoding="utf-8")
            core_path = Path(directory) / loader.CORE_NAME
            with patch.object(loader, "release_core", return_value=core_path), \
                    patch.object(loader.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
                    patch.object(Path, "unlink", side_effect=OSError("locked")):
                with self.assertRaisesRegex(ValueError, "cleanup failed"):
                    loader.run_request(request_path)


if __name__ == "__main__":
    unittest.main()
