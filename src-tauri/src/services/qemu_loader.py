"""Guest-side loader for the server-authoritative protected runner.

This file is a generic bootstrap only. The protected qemu_guest.py artifact is
requested over HTTPS from inside the guest and is never staged by Tauri.
"""
import base64
import binascii
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


EXECUTION_RELEASE_URL = "__RDC_EXECUTION_RELEASE_URL__"
EXECUTION_GRANT_PUBLIC_KEYS = "__RDC_AUTH_PUBLIC_KEYS__"
MAX_CORE_BYTES = 512 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_GRANT_PAYLOAD_BYTES = 64 * 1024
MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024
CORE_NAME = "qemu_guest.py"


def _decode_urlsafe(value, label, max_bytes=None):
    if not isinstance(value, str) or not value:
        raise ValueError("Invalid release " + label)
    if max_bytes is not None and len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise ValueError("Release " + label + " is too large")
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(value + padding)
    except (ValueError, binascii.Error) as error:
        raise ValueError("Invalid release " + label) from error
    if max_bytes is not None and len(decoded) > max_bytes:
        raise ValueError("Release " + label + " is too large")
    return decoded


def _release_endpoint():
    endpoint = EXECUTION_RELEASE_URL
    if not isinstance(endpoint, str) or not endpoint or endpoint.startswith("__RDC_"):
        raise ValueError("Protected core release service is not configured")
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.fragment:
        raise ValueError("Protected core release URL is invalid")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Protected core release URL must use HTTPS")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Protected core release URL port is invalid") from error
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return parsed, port, path


def _grant_claims(grant):
    if not isinstance(grant, dict):
        raise ValueError("A signed execution grant is required")
    for field in ("key_id", "payload", "signature", "device_proof"):
        if not isinstance(grant.get(field), str) or not grant[field]:
            raise ValueError("Execution grant " + field + " is required")
    try:
        claims = json.loads(_decode_urlsafe(
            grant["payload"], "grant payload", MAX_GRANT_PAYLOAD_BYTES
        ).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Execution grant payload is invalid") from error
    if not isinstance(claims, dict):
        raise ValueError("Execution grant payload is invalid")
    artifact_id = claims.get("artifact_id")
    artifact_sha256 = claims.get("artifact_sha256")
    if not isinstance(artifact_id, str) or not artifact_id:
        raise ValueError("Execution grant artifact is missing")
    if (not isinstance(artifact_sha256, str) or len(artifact_sha256) != 64
            or any(char not in "0123456789abcdef" for char in artifact_sha256)):
        raise ValueError("Execution grant artifact hash is invalid")
    return claims


def _request_release(grant):
    parsed, port, path = _release_endpoint()
    body = json.dumps({"grant": grant}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = None
    try:
        connection = connection_class(parsed.hostname, port, timeout=10)
        connection.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
            },
        )
        response = connection.getresponse()
        raw = response.read(MAX_RELEASE_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RELEASE_RESPONSE_BYTES:
            raise ValueError("Protected core release response is too large")
        if response.status != 200:
            raise ValueError("Protected core release request was rejected")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Protected core release response is invalid") from error
        if not isinstance(value, dict):
            raise ValueError("Protected core release response is invalid")
        return value
    except (OSError, TimeoutError, http.client.HTTPException) as error:
        raise ValueError("Protected core release service is unavailable") from error
    finally:
        if connection is not None:
            connection.close()


def release_core(request, work_dir):
    if not isinstance(request, dict):
        raise ValueError("Protected core request is invalid")
    grant = request.get("executionGrant")
    claims = _grant_claims(grant)
    response = _request_release(grant)
    artifact_id = response.get("artifact_id")
    artifact_sha256 = response.get("artifact_sha256")
    size_bytes = response.get("artifact_size_bytes")
    if artifact_id != claims["artifact_id"]:
        raise ValueError("Protected core release artifact does not match the grant")
    if artifact_sha256 != claims["artifact_sha256"]:
        raise ValueError("Protected core release artifact hash does not match the grant")
    if type(size_bytes) is not int or size_bytes < 0 or size_bytes > MAX_CORE_BYTES:
        raise ValueError("Protected core release size is invalid")
    content = _decode_urlsafe(response.get("content_base64"), "artifact content", MAX_CORE_BYTES)
    if len(content) != size_bytes or len(content) > MAX_CORE_BYTES:
        raise ValueError("Protected core release size does not match the content")
    if hashlib.sha256(content).hexdigest() != artifact_sha256:
        raise ValueError("Protected core release artifact hash is invalid")

    work_dir = Path(work_dir)
    work_dir.mkdir(mode=0o700, parents=False, exist_ok=True)
    core_path = work_dir / CORE_NAME
    try:
        descriptor = os.open(str(core_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        raise ValueError("Protected core cannot be staged inside the guest") from error
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        os.chmod(core_path, 0o600)
    except Exception as error:
        try:
            core_path.unlink()
        except OSError as cleanup_error:
            raise ValueError(
                "Protected core cannot be secured inside the guest; cleanup failed"
            ) from cleanup_error
        raise ValueError("Protected core cannot be secured inside the guest") from error
    return core_path


def read_bounded_request(request_path):
    request_path = Path(request_path)
    try:
        raw = request_path.read_bytes()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Protected core request cannot be read") from error
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("Protected core request is too large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Protected core request cannot be read") from error
    if not isinstance(request, dict):
        raise ValueError("Protected core request is invalid")
    return request


def run_request(request_path):
    request_path = Path(request_path)
    request = read_bounded_request(request_path)
    core_path = None
    try:
        core_path = release_core(request, request_path.parent)
        result = subprocess.run(
            [sys.executable, str(core_path), str(request_path)],
            check=False,
        )
        return result.returncode
    finally:
        if core_path is not None:
            try:
                core_path.unlink()
            except OSError as error:
                raise ValueError("Protected core cleanup failed") from error


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Protected core request path is required")
        sys.exit(run_request(sys.argv[1]))
    except Exception as error:
        print("[error] " + str(error), file=sys.stderr)
        sys.exit(1)
