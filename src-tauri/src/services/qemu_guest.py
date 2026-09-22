"""Node-side preset runner. Python stdlib; Docker only inside the QEMU guest."""
import copy
import base64
import binascii
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import quote, urlsplit

SDK_VERSIONS = {29: "10", 30: "11", 31: "12", 32: "12", 33: "13", 34: "14", 35: "15", 36: "16"}

# These values are rendered into the protected artifact at release time. The
# guest must trust a key shipped with the artifact itself; accepting a key from
# the request would let a copied runner mint its own execution grants.
EXECUTION_GRANT_KEY_ID = "__RDC_EXECUTION_KEY_ID__"
EXECUTION_GRANT_PUBLIC_KEY = "__RDC_EXECUTION_PUBLIC_KEY__"
EXECUTION_GRANT_CONSUME_URL = "__RDC_EXECUTION_CONSUME_URL__"
EXECUTION_GRANT_ISSUER = "rdc-auth"
EXECUTION_GRANT_AUDIENCE = "rdc-guest-runner"
EXECUTION_AUTHORIZATION_AUDIENCE = "rdc-qemu-center"
EXECUTION_GRANT_CLOCK_SKEW_SECS = 300
EXECUTION_GRANT_MAX_REQUEST_AGE_SECS = 300
MAX_EXECUTION_GRANT_FIELD_BYTES = 256
MAX_EXECUTION_GRANT_PAYLOAD_BYTES = 64 * 1024
MAX_EXECUTION_CONSUME_RESPONSE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 64 * 1024
MAX_SUBPROCESS_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_DOCKER_RESPONSE_BYTES = 1 * 1024 * 1024
EXECUTION_AUTHORIZATION_ROOT = "/run/rdc-presets"


def _decode_urlsafe_base64(value, label, max_bytes=None):
    if not isinstance(value, str) or not value:
        raise ValueError("Invalid execution grant " + label)
    if max_bytes is not None and len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise ValueError("Execution grant " + label + " is too large")
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(value + padding)
    except (ValueError, binascii.Error) as error:
        raise ValueError("Invalid execution grant " + label) from error
    if max_bytes is not None and len(decoded) > max_bytes:
        raise ValueError("Execution grant " + label + " is too large")
    return decoded


def _ed25519_public_key_pem(public_key):
    raw = _decode_urlsafe_base64(public_key, "public key", 32)
    if len(raw) != 32:
        raise ValueError("Invalid execution grant public key")
    der = bytes.fromhex("302a300506032b6570032100") + raw
    encoded = base64.b64encode(der).decode("ascii")
    return "-----BEGIN PUBLIC KEY-----\n" + encoded + "\n-----END PUBLIC KEY-----\n"


def verify_execution_grant(request, expected_workflow, expected_vm, expected_instance):
    grant = request.get("executionGrant")
    if not isinstance(grant, dict):
        raise ValueError("A signed execution grant is required")
    if not isinstance(grant.get("device_proof"), str) or not grant["device_proof"]:
        raise ValueError("Execution grant device proof is required")
    if grant.get("key_id") != EXECUTION_GRANT_KEY_ID:
        raise ValueError("Execution grant key is not trusted")
    payload = _decode_urlsafe_base64(grant.get("payload"), "payload", MAX_EXECUTION_GRANT_PAYLOAD_BYTES)
    signature = _decode_urlsafe_base64(grant.get("signature"), "signature", 64)
    if len(signature) != 64:
        raise ValueError("Invalid execution grant signature")
    with tempfile.TemporaryDirectory(prefix="rdc-grant-") as temp:
        root = Path(temp)
        public_key = root / "grant.pub"
        signed_payload = root / "grant.payload"
        signed_signature = root / "grant.sig"
        public_key.write_text(_ed25519_public_key_pem(EXECUTION_GRANT_PUBLIC_KEY))
        signed_payload.write_bytes(payload)
        signed_signature.write_bytes(signature)
        checked = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key),
             "-rawin", "-in", str(signed_payload), "-sigfile", str(signed_signature)],
            capture_output=True, text=True, timeout=10,
        )
    if checked.returncode != 0:
        raise ValueError("Execution grant signature is invalid")
    try:
        claims = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Execution grant payload is invalid") from error
    if not isinstance(claims, dict):
        raise ValueError("Execution grant payload is not an object")
    required = ("iss", "aud", "client_id", "device_id", "session_id", "client_version", "artifact_id",
                "artifact_sha256", "action", "vm", "instance", "iat", "exp", "jti", "nonce")
    if any(not claims.get(field) for field in required):
        raise ValueError("Execution grant payload is incomplete")
    string_fields = tuple(field for field in required if field not in ("iat", "exp"))
    if any(not isinstance(claims[field], str) for field in string_fields):
        raise ValueError("Execution grant payload is incomplete")
    if any(len(claims[field]) > MAX_EXECUTION_GRANT_FIELD_BYTES for field in
           ("client_id", "device_id", "session_id", "client_version", "artifact_id",
            "action", "vm", "instance", "jti", "nonce")):
        raise ValueError("Execution grant payload field is too large")
    if claims["iss"] != EXECUTION_GRANT_ISSUER or claims["aud"] != EXECUTION_GRANT_AUDIENCE:
        raise ValueError("Execution grant issuer or audience is invalid")
    if type(claims["iat"]) is not int or type(claims["exp"]) is not int:
        raise ValueError("Execution grant timestamps are invalid")
    now = int(time.time())
    if claims["exp"] <= now \
            or claims["iat"] < now - EXECUTION_GRANT_MAX_REQUEST_AGE_SECS \
            or claims["iat"] > now + EXECUTION_GRANT_CLOCK_SKEW_SECS:
        raise ValueError("Execution grant is expired or not yet valid")
    if claims["exp"] <= claims["iat"]:
        raise ValueError("Execution grant expiry is invalid")
    if claims["action"] != expected_workflow or claims["vm"] != expected_vm \
            or claims["instance"] != expected_instance:
        raise ValueError("Execution grant is bound to another operation")
    if len(claims["artifact_sha256"]) != 64 or \
            claims["artifact_sha256"] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise ValueError("Execution grant is bound to another core artifact")
    return claims


def consume_execution_grant(grant):
    endpoint = EXECUTION_GRANT_CONSUME_URL
    if not isinstance(endpoint, str) or not endpoint or endpoint.startswith("__RDC_EXECUTION_"):
        raise ValueError("Execution grant consume service is not configured")
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.fragment:
        raise ValueError("Execution grant consume URL is invalid")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Execution grant consume URL must use HTTPS")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Execution grant consume URL port is invalid") from error
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    body = json.dumps({"grant": grant}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    connection = None
    try:
        connection = connection_class(parsed.hostname, port, timeout=10)
        connection.request(
            "POST",
            path,
            body=body,
            headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
        )
        response = connection.getresponse()
        if response.status == 200:
            content_length = None
            getheader = getattr(response, "getheader", None)
            if getheader is not None:
                content_length = getheader("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except (TypeError, ValueError) as error:
                    raise ValueError("Execution authorization receipt size is invalid") from error
                if declared_length < 0 or declared_length > MAX_EXECUTION_CONSUME_RESPONSE_BYTES:
                    raise ValueError("Execution authorization receipt is too large")
            raw = response.read(MAX_EXECUTION_CONSUME_RESPONSE_BYTES + 1)
            if len(raw) > MAX_EXECUTION_CONSUME_RESPONSE_BYTES:
                raise ValueError("Execution authorization receipt is too large")
        if response.status == 200:
            try:
                receipt = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("Execution authorization receipt is invalid") from error
            if not isinstance(receipt, dict):
                raise ValueError("Execution authorization receipt is invalid")
            return receipt
        if response.status == 409:
            raise ValueError("Execution grant has already been consumed")
        raise ValueError("Execution grant consume request was rejected")
    except (OSError, TimeoutError, http.client.HTTPException) as error:
        raise ValueError("Execution grant consume service is unavailable") from error
    finally:
        if connection is not None:
            connection.close()


def _execution_authorization_marker(request):
    raw = request.get("executionAuthorizationPath")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Execution authorization marker is required")
    root = str(EXECUTION_AUTHORIZATION_ROOT).replace("\\", "/").rstrip("/")
    normalized = raw.replace("\\", "/")
    if not normalized.startswith(root + "/") or "/../" in normalized or normalized.endswith("/.."):
        raise ValueError("Execution authorization marker path is invalid")
    marker = Path(raw)
    if marker.name != "execution-authorized":
        raise ValueError("Execution authorization marker name is invalid")
    return marker


def _validate_immutable_image_ref(image):
    if not isinstance(image, str):
        raise ValueError("Protected image must use a complete SHA-256 digest")
    name, separator, digest = image.partition("@sha256:")
    if not separator or not name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:~-]*", name):
        raise ValueError("Protected image must use a complete SHA-256 digest")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError("Protected image must use a complete SHA-256 digest")


def validate_runner_request(request, request_path=None):
    if not isinstance(request, dict):
        raise ValueError("Protected core request is invalid")
    action = request.get("action")
    if action not in {"authorize", "activate", "build", "seed", "upgrade", "restore", "details"}:
        raise ValueError("Unknown guest action")
    module_ids = request.get("moduleIds", [])
    if not isinstance(module_ids, list) or len(module_ids) > 64 \
            or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value)
                   for value in module_ids):
        raise ValueError("Invalid module id list")
    expected_props = request.get("expectedProps", {})
    if not isinstance(expected_props, dict) or len(expected_props) > 64 \
            or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", key)
                   or not isinstance(value, str) or len(value) > 512
                   for key, value in expected_props.items()):
        raise ValueError("Invalid expected property map")
    hide_packages = request.get("hidePackages", [])
    if not isinstance(hide_packages, list) or len(hide_packages) > 128 \
            or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._$]{1,128}", value)
                   for value in hide_packages):
        raise ValueError("Invalid hidden package list")
    context = request.get("context")
    if context is not None:
        if not isinstance(context, str) or len(context) > 512 or not Path(context).is_absolute():
            raise ValueError("Build context path is invalid")
        root = Path(EXECUTION_AUTHORIZATION_ROOT).resolve()
        resolved = Path(context).resolve()
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise ValueError("Build context path is outside the protected root") from error
        if request_path is not None and resolved != Path(request_path).resolve().parent:
            raise ValueError("Build context path does not match the request directory")
    if action == "build":
        _validate_immutable_image_ref(request.get("baseImage"))


def read_bounded_request(request_path):
    request_path = Path(request_path)
    try:
        raw = request_path.read_bytes()
    except OSError as error:
        raise ValueError("Protected core request cannot be read") from error
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("Protected core request is too large")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Protected core request is invalid") from error
    validate_runner_request(request, request_path)
    return request


def run_bounded_subprocess(args, timeout=120):
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output = {"stdout": bytearray(), "stderr": bytearray(), "overflow": False}
    lock = threading.Lock()

    def read_stream(name, stream):
        while True:
            chunk = stream.read(8192)
            if not chunk:
                return
            with lock:
                if len(output[name]) + len(chunk) > MAX_SUBPROCESS_OUTPUT_BYTES:
                    output["overflow"] = True
                    try:
                        process.kill()
                    except OSError:
                        pass
                    return
                output[name].extend(chunk)

    readers = [threading.Thread(target=read_stream, args=(name, stream), daemon=True)
               for name, stream in (("stdout", process.stdout), ("stderr", process.stderr))]
    for reader in readers:
        reader.start()
    try:
        return_code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        for reader in readers:
            reader.join()
        for stream in (process.stdout, process.stderr):
            stream.close()
        raise
    for reader in readers:
        reader.join()
    for stream in (process.stdout, process.stderr):
        stream.close()
    if output["overflow"]:
        raise ValueError("Subprocess output is too large")
    return subprocess.CompletedProcess(
        args,
        return_code,
        bytes(output["stdout"]).decode(errors="replace"),
        bytes(output["stderr"]).decode(errors="replace"),
    )


def _verify_execution_authorization_receipt(receipt, claims):
    if not isinstance(receipt, dict):
        raise ValueError("Execution authorization receipt is invalid")
    if receipt.get("key_id") != EXECUTION_GRANT_KEY_ID:
        raise ValueError("Execution authorization receipt key is not trusted")
    payload = _decode_urlsafe_base64(receipt.get("payload"), "authorization receipt payload",
                                     MAX_EXECUTION_GRANT_PAYLOAD_BYTES)
    signature = _decode_urlsafe_base64(receipt.get("signature"), "authorization receipt signature", 64)
    if len(signature) != 64:
        raise ValueError("Invalid execution authorization receipt signature")
    with tempfile.TemporaryDirectory(prefix="rdc-receipt-") as temp:
        root = Path(temp)
        public_key = root / "receipt.pub"
        signed_payload = root / "receipt.payload"
        signed_signature = root / "receipt.sig"
        public_key.write_text(_ed25519_public_key_pem(EXECUTION_GRANT_PUBLIC_KEY))
        signed_payload.write_bytes(payload)
        signed_signature.write_bytes(signature)
        checked = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(public_key),
             "-rawin", "-in", str(signed_payload), "-sigfile", str(signed_signature)],
            capture_output=True, text=True, timeout=10,
        )
    if checked.returncode != 0:
        raise ValueError("Execution authorization receipt signature is invalid")
    try:
        receipt_claims = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Execution authorization receipt payload is invalid") from error
    required = ("iss", "aud", "client_id", "device_id", "session_id", "client_version",
                "artifact_id", "artifact_sha256", "action", "vm", "instance", "grant_jti",
                "iat", "exp")
    if not isinstance(receipt_claims, dict) or any(not receipt_claims.get(field) for field in required):
        raise ValueError("Execution authorization receipt payload is incomplete")
    if receipt_claims["iss"] != EXECUTION_GRANT_ISSUER \
            or receipt_claims["aud"] != EXECUTION_AUTHORIZATION_AUDIENCE:
        raise ValueError("Execution authorization receipt issuer or audience is invalid")
    if type(receipt_claims["iat"]) is not int or type(receipt_claims["exp"]) is not int:
        raise ValueError("Execution authorization receipt timestamps are invalid")
    now = int(time.time())
    if receipt_claims["exp"] <= now or receipt_claims["iat"] > now + EXECUTION_GRANT_CLOCK_SKEW_SECS \
            or receipt_claims["exp"] <= receipt_claims["iat"]:
        raise ValueError("Execution authorization receipt is expired or not yet valid")
    for field in ("client_id", "device_id", "session_id", "client_version", "artifact_id",
                  "artifact_sha256", "action", "vm", "instance"):
        if receipt_claims[field] != claims[field]:
            raise ValueError("Execution authorization receipt is bound to another operation")
    if receipt_claims["grant_jti"] != claims["jti"]:
        raise ValueError("Execution authorization receipt is bound to another grant")
    return receipt_claims


def write_execution_authorization_marker(request, claims, receipt):
    _verify_execution_authorization_receipt(receipt, claims)
    marker = _execution_authorization_marker(request)
    try:
        descriptor = os.open(str(marker), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise ValueError("Execution authorization marker already exists") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(receipt, separators=(",", ":"), ensure_ascii=False))
        if os.name == "posix":
            import pwd
            owner = pwd.getpwnam("rdc")
            os.chown(marker, owner.pw_uid, owner.pw_gid)
        os.chmod(marker, 0o600)
    except Exception as error:
        try:
            marker.unlink()
        except OSError:
            pass
        raise ValueError("Execution authorization marker cannot be secured") from error


def require_execution_authorization_marker(request, claims):
    marker = _execution_authorization_marker(request)
    try:
        value = marker.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError("Execution authorization marker is missing") from error
    try:
        receipt = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("Execution authorization marker is not a signed receipt") from error
    _verify_execution_authorization_receipt(receipt, claims)


def android_version(props):
    values = dict(line.split("=", 1) for line in props.splitlines() if "=" in line and not line.startswith("#"))
    try:
        return SDK_VERSIONS[int(values["ro.build.version.sdk"].strip())]
    except (ValueError, KeyError):
        raise ValueError("Cannot determine actual Android SDK from immutable build.prop")


def data_volume(inspected):
    mounts = [m for m in inspected.get("Mounts", []) if m["Destination"] == "/data"]
    if len(mounts) != 1 or mounts[0]["Type"] != "volume" or not mounts[0].get("RW", True):
        raise ValueError("Upgrade requires one writable Docker volume at /data")
    return mounts[0]["Name"]


def clone_config(inspected, image, old_volume, new_volume):
    config = copy.deepcopy(inspected["Config"])
    host = copy.deepcopy(inspected["HostConfig"])
    config["Image"] = image
    # Preserve user hostname, env, command, labels, security and resource limits.
    host["Binds"] = [new_volume + b[len(old_volume):] if b.split(":", 1)[0] == old_volume else b
                     for b in host.get("Binds") or []]
    for mount in host.get("Mounts") or []:
        if mount.get("Target") == "/data" and mount.get("Type") == "volume":
            mount["Source"] = new_volume
    # Engine may represent anonymous volumes without Binds/Mounts.
    if not any(b.split(":", 2)[1:2] == ["/data"] for b in host["Binds"]) and not any(
            m.get("Target") == "/data" for m in host.get("Mounts") or []):
        host["Binds"].append(new_volume + ":/data")
    host["ContainerIDFile"] = ""
    config["HostConfig"] = host
    mode = host.get("NetworkMode", "bridge")
    if mode not in ("bridge", "default", "host", "none"):
        raise ValueError("Upgrade currently requires bridge/host/none networking; custom networks are preserved only by manual migration")
    return config


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


class Docker:
    def cli(self, *args, timeout=120):
        result = run_bounded_subprocess(["docker", *args], timeout=timeout)
        if result.returncode:
            raise RuntimeError("docker " + args[0] + ": " + result.stderr.strip())
        return result.stdout.strip()

    def inspect(self, name):
        return json.loads(self.cli("inspect", name))[0]

    def inspect_size(self, name):
        return json.loads(self.cli("inspect", "--size", name))[0]

    def exists(self, name):
        return subprocess.run(["docker", "inspect", name], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=30).returncode == 0

    def create(self, name, config):
        connection = UnixHTTP("localhost", timeout=120)
        try:
            connection.request("POST", "/containers/create?name=" + quote(name, safe=""),
                               json.dumps(config), {"Content-Type": "application/json"})
            response = connection.getresponse()
            body = response.read(MAX_DOCKER_RESPONSE_BYTES + 1)
            if len(body) > MAX_DOCKER_RESPONSE_BYTES:
                raise ValueError("Docker response is too large")
            body = body.decode(errors="replace")
            if response.status != 201:
                raise RuntimeError("container create: " + body)
            return json.loads(body)["Id"]
        finally:
            connection.close()

    def stop(self, name):
        self.cli("stop", "-t", "30", name, timeout=90)

    def start(self, name):
        self.cli("start", name)

    def rename(self, old, new):
        self.cli("rename", old, new)

    def update_restart(self, name, policy):
        value = policy.get("Name") or "no"
        if value == "on-failure" and policy.get("MaximumRetryCount"):
            value += ":" + str(policy["MaximumRetryCount"])
        self.cli("update", "--restart", value, name)

    def remove(self, name):
        self.cli("rm", "-f", name)

    def shell(self, name, script, timeout=30):
        return self.cli("exec", name, "/system/bin/sh", "-c", script, timeout=timeout)


def image_version(docker, image):
    # Never start the container for preflight. In redroid images /system/bin/sh
    # is a dynamic executable whose interpreter (/system/bin/linker64) resolves
    # into an APEX package that only Android's init mounts, so replacing the
    # entrypoint can never exec it: "exec /system/bin/sh: no such file or
    # directory". Read the immutable build.prop straight out of the image.
    container = docker.cli("create", image)
    try:
        props = ""
        for path in ("/system/build.prop", "/system/system/build.prop"):
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    docker.cli("cp", container + ":" + path, tmp, timeout=120)
                except RuntimeError:
                    continue  # Absent in most images; the other path carries sdk.
                copied = Path(tmp) / Path(path).name
                if copied.is_file():
                    props += copied.read_text(errors="replace") + "\n"
        return android_version(props)
    finally:
        docker.cli("rm", "-f", container)


def device_version(docker, name):
    # File values survive resetprop spoofing and work on stopped containers.
    inspected = docker.inspect(name)
    return image_version(docker, inspected["Config"]["Image"])


def volume_path(docker, volume):
    info = json.loads(docker.cli("volume", "inspect", volume))[0]
    if info.get("Driver") != "local" or info.get("Options"):
        raise ValueError("Upgrade supports standard local Docker volumes only")
    path = Path(info["Mountpoint"]).resolve()
    if not path.is_dir() or not str(path).startswith("/var/lib/docker/volumes/"):
        raise ValueError("Unexpected Docker volume mountpoint: " + str(path))
    return path


def clone_volume(docker, old, new):
    source = volume_path(docker, old)
    docker.cli("volume", "create", new)
    target = volume_path(docker, new)
    # GNU cp -a preserves numeric ownership, mode, xattrs, symlinks and times.
    subprocess.run(["cp", "-a", str(source) + "/.", str(target)], check=True, timeout=600)


def seed_data(docker, volume, request):
    root = volume_path(docker, volume)
    adb = root / "misc/adb"
    adb.mkdir(parents=True, exist_ok=True)
    key = request.get("adbPubkey", "").strip()
    if key:
        path = adb / "adb_keys"
        existing = path.read_text() if path.exists() else ""
        if key not in existing.splitlines():
            path.write_text(existing.rstrip("\n") + ("\n" if existing else "") + key + "\n")
        os.chown(path, 1000, 2000)
        os.chmod(path, 0o640)
    if request.get("installMagisk"):
        preset = root / "adb"
        preset.mkdir(parents=True, exist_ok=True)
        (preset / ".rdc_preset_done").unlink(missing_ok=True)
        (preset / "rdc_target_packages.txt").write_text("\n".join(request.get("hidePackages") or []) + "\n")
        # Copy profile to data before boot; runtime service uses data copy first.
        conf = Path(request.get("context", ".")) / "data/spoof.conf"
        if conf.is_file():
            (preset / "rdc_spoof.conf").write_bytes(conf.read_bytes())
        for module in request.get("moduleIds") or []:
            # Upgrade selected modules even if a previous version exists.
            staged = preset / "modules" / module
            if staged.is_dir():
                subprocess.run(["rm", "-rf", "--", str(staged)], check=True)
    cloak = Path(request.get("context", ".")) / "cloak.json"
    if cloak.is_file():
        tmp = root / "local/tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        (tmp / "rdc-cloak.json").write_bytes(cloak.read_bytes())
        os.chmod(tmp / "rdc-cloak.json", 0o644)


def wait_boot(docker, name, preset=False):
    deadline = time.monotonic() + 300
    last = ""
    while time.monotonic() < deadline:
        try:
            last = docker.shell(name, "getprop sys.boot_completed" +
                                ("; test -f /data/adb/.rdc_preset_done && echo preset_done" if preset else ""))
            if last.splitlines()[0:1] == ["1"] and (not preset or "preset_done" in last):
                return
        except RuntimeError as error:
            last = str(error)
        time.sleep(3)
    raise RuntimeError("First boot/preset timeout: " + last)


def activate(docker, name, request):
    wait_boot(docker, name, request.get("installMagisk", False))
    if request.get("installMagisk"):
        print("[stage] Restarting to activate Zygisk/modules", flush=True)
        docker.cli("restart", name, timeout=90)
        wait_boot(docker, name, True)
        checks = docker.shell(name,
            "pidof magiskd; /sbin/magisk --sqlite \"SELECT value FROM settings WHERE key='zygisk'\"; "
            "pidof zygiskd zygiskd64; pm path com.topjohnwu.magisk")
        rows = checks.splitlines()
        if not any("value=1" in line for line in rows) or not any("package:" in line for line in rows):
            raise RuntimeError("Magisk manager / Zygisk configuration not verified: " + checks)
        if not docker.shell(name, "pidof magiskd") or not docker.shell(name, "pidof zygiskd zygiskd64"):
            raise RuntimeError("Magisk daemon or Zygisk process is absent")
        for module in request.get("moduleIds") or []:
            quoted = "'" + module + "'"
            docker.shell(name, "test -d /data/adb/modules/" + quoted +
                         " && test ! -f /data/adb/modules/" + quoted + "/disable" +
                         " && test ! -f /data/adb/modules/" + quoted + "/remove")
        if request.get("installLsposed") and not docker.shell(name, "pidof lspd"):
            raise RuntimeError("LSPosed module installed but lspd is not running")
        if request.get("expectedProps"):
            for prop, expected in request["expectedProps"].items():
                if docker.shell(name, "getprop " + prop) != expected:
                    raise RuntimeError("Device profile property mismatch: " + prop)
        print("[verified] Magisk daemon, manager, configured and active Zygisk, selected modules/profile", flush=True)
    if request.get("installGapps"):
        for package in ("com.google.android.gms", "com.google.android.gsf", "com.android.vending"):
            if not docker.shell(name, "pm path " + package).startswith("package:"):
                raise RuntimeError("GApps package missing: " + package)
        docker.shell(name, "settings put global device_provisioned 1; settings put secure user_setup_complete 1; "
                     "pm disable-user --user 0 com.google.android.setupwizard >/dev/null 2>&1; "
                     "settings put global package_verifier_enable 0; settings put global verifier_verify_adb_installs 0; true")
        print("[verified] GMS, GSF, Play Store; headless provisioning complete", flush=True)
    if request.get("installCloak"):
        docker.cli("cp", str(Path(request["context"]) / "DeviceCloak.apk"), name + ":/data/local/tmp/DeviceCloak.apk")
        result = docker.shell(name, "settings put global package_verifier_enable 0; pm install -r /data/local/tmp/DeviceCloak.apk", timeout=120)
        if "Success" not in result or not docker.shell(name, "pm path dev.rdc.devicecloak").startswith("package:"):
            raise RuntimeError("DeviceCloak installation failed: " + result)
        print("[manual] DeviceCloak installed; enable it and select target apps in LSPosed Manager", flush=True)
    docker.shell(name, "settings put global stay_on_while_plugged_in 7; input keyevent KEYCODE_WAKEUP; true")


def configure_traces(config, request):
    if not request.get("cleanTraces"):
        return
    context = Path(request["context"]).resolve()
    for filename, destination in (("cpuinfo", "/proc/cpuinfo"), ("version", "/proc/version")):
        path = context / "traces" / filename
        if not path.is_file():
            raise ValueError("Trace configuration requires a device profile")
        binds = config["HostConfig"].setdefault("Binds", [])
        binds[:] = [b for b in binds if b.split(":", 2)[1:2] != [destination]]
        binds.append(str(path) + ":" + destination + ":ro")
    config["HostConfig"]["CgroupParent"] = "system.slice"


def upgrade(docker, request):
    name = "qc-" + request["name"]
    backup = name + "-preupgrade"
    if docker.exists(backup):
        raise ValueError("An upgrade backup already exists; restore it or remove it deliberately before another upgrade")
    inspected = docker.inspect(name)
    old_volume = data_volume(inspected)
    target_version = image_version(docker, request["image"])
    current_version = device_version(docker, name)
    if current_version != target_version:
        raise ValueError("Android version must stay unchanged: current=" + current_version + ", target=" + target_version)
    new_volume = name + "-upgrade-" + uuid.uuid4().hex[:12] + "-data"
    config = clone_config(inspected, request["image"], old_volume, new_volume)
    configure_traces(config, request)
    policy = inspected["HostConfig"].get("RestartPolicy") or {"Name": "no"}
    running = inspected["State"]["Running"]
    renamed = False
    created = False
    try:
        print("[stage] Stopping instance and cloning data; original volume remains intact", flush=True)
        docker.stop(name)
        clone_volume(docker, old_volume, new_volume)
        seed_data(docker, new_volume, request)
        docker.update_restart(name, {"Name": "no"})
        docker.rename(name, backup)
        renamed = True
        config.setdefault("Labels", {})["rdc.qemu.rollback"] = json.dumps({"policy": policy, "running": running})
        docker.create(name, config)
        created = True
        docker.start(name)
        activate(docker, name, request)
        print("[upgrade] Complete. Original container: " + backup + "; original data: " + old_volume, flush=True)
    except Exception as error:
        try:
            if created:
                docker.remove(name)
            if renamed:
                docker.rename(backup, name)
            docker.update_restart(name, policy)
            if running:
                docker.start(name)
        except Exception as rollback_error:
            raise RuntimeError(str(error) + "; automatic restore FAILED: " + str(rollback_error) + "; backup=" + backup)
        raise RuntimeError(str(error) + "; original instance restored; cloned volume retained: " + new_volume)


def restore(docker, request):
    name = "qc-" + request["name"]
    backup = name + "-preupgrade"
    if not docker.exists(backup):
        raise ValueError("No pre-upgrade backup available")
    current = docker.inspect(name)
    original = docker.inspect(backup)
    metadata = json.loads(current["Config"].get("Labels", {}).get("rdc.qemu.rollback", "{}"))
    policy = metadata.get("policy", original["HostConfig"].get("RestartPolicy") or {"Name": "no"})
    retained = name + "-replaced-" + uuid.uuid4().hex[:12]
    renamed = False
    try:
        docker.stop(name)
        docker.update_restart(name, {"Name": "no"})
        docker.rename(name, retained)
        renamed = True
        docker.rename(backup, name)
        docker.update_restart(name, policy)
        if metadata.get("running", True):
            docker.start(name)
    except Exception:
        if renamed:
            if docker.exists(name):
                docker.rename(name, backup)
            docker.rename(retained, name)
            docker.update_restart(name, current["HostConfig"].get("RestartPolicy") or {"Name": "no"})
            if current["State"]["Running"]:
                docker.start(name)
        raise
    print("[restore] Original instance restored; upgraded data retained in " + retained)


def runtime_metrics(inspected):
    """Project only stable, read-only docker inspect --size fields."""
    host = inspected.get("HostConfig") or {}
    state = inspected.get("State") or {}
    measured = False

    nano = host.get("NanoCpus")
    if isinstance(nano, int):
        measured = True
        cpu_quota = None if nano == 0 else nano / 1_000_000_000
        cpu_unlimited = nano == 0
    else:
        cpu_quota = None
        cpu_unlimited = None

    memory = host.get("Memory")
    if isinstance(memory, int):
        measured = True
        memory_quota = None if memory == 0 else memory
        memory_unlimited = memory == 0
    else:
        memory_quota = None
        memory_unlimited = None

    disk = inspected.get("SizeRw")
    if isinstance(disk, int):
        measured = True
        disk_bytes = disk
    else:
        disk_bytes = None

    def clean_time(value):
        value = str(value or "").strip()
        return None if not value or value.startswith("0001-01-01") else value

    started_at = clean_time(state.get("StartedAt"))
    finished_at = clean_time(state.get("FinishedAt"))
    measured = measured or started_at is not None or finished_at is not None
    if not measured:
        return None
    return {
        "cpuQuotaCores": cpu_quota,
        "cpuUnlimited": cpu_unlimited,
        "memoryQuotaBytes": memory_quota,
        "memoryUnlimited": memory_unlimited,
        "diskBytes": disk_bytes,
        "startedAt": started_at,
        "finishedAt": finished_at,
    }


def details(docker, request):
    rows = []
    for instance in request.get("names") or []:
        name = "qc-" + instance
        if not docker.exists(name):
            continue
        inspected = docker.inspect_size(name)
        version = ""
        try:
            # Cached immutable version label for derived images; fallback to file probe.
            version = inspected["Config"].get("Labels", {}).get("rdc.qemu.android", "") or device_version(docker, name)
        except (ValueError, RuntimeError):
            pass
        rows.append({"instance": instance, "androidVersion": version, "image": inspected["Config"]["Image"],
                     "resourceProfile": inspected["Config"].get("Labels", {}).get("rdc.qemu.profile", "standard"),
                     "rollbackAvailable": docker.exists(name + "-preupgrade"),
                     "metrics": runtime_metrics(inspected)})
    print(json.dumps(rows))


def main(request, request_path=None):
    validate_runner_request(request, request_path)
    name = request.get("name", "")
    if name and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,23}", name):
        raise ValueError("Invalid instance name")
    action = request["action"]
    workflow = {"details": "preset_details", "restore": "preset_restore"}.get(
        action, "preset_apply")
    expected_instance = request.get("executionInstance", name)
    grant = request.get("executionGrant")
    claims = verify_execution_grant(request, workflow, request.get("vm", ""), expected_instance)
    if action == "authorize":
        receipt = consume_execution_grant(grant)
        write_execution_authorization_marker(request, claims, receipt)
        print("[authorized] execution grant consumed", flush=True)
        return
    if action == "activate":
        require_execution_authorization_marker(request, claims)
        # The activation grant was consumed by the guest preflight before the
        # host-side Docker create. Remove the marker before protected work so
        # the same one-time authorization cannot be replayed.
        _execution_authorization_marker(request).unlink()
    else:
        consume_execution_grant(grant)
    docker = Docker()
    if action == "details":
        details(docker, request)
        return
    import fcntl
    # Prevent repeated clicks or independent app invocations racing on one instance.
    lock_path = Path("/var/lock/rdc-qemu-" + (name or "images") + ".lock")
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("An operation is already running for this instance")
        if action == "build":
            version = image_version(docker, request["baseImage"])
            if version != request["androidVersion"]:
                raise ValueError("Image Android version differs from selected version: " + version)
            architecture = json.loads(docker.cli("image", "inspect", request["baseImage"]))[0]["Architecture"]
            if architecture != "amd64":
                raise ValueError("QEMU presets require an x86_64/amd64 image")
            build_args = ["build", "--label", "rdc.qemu.android=" + version]
            build_args.extend(["--label", "rdc.qemu.profile=" + (request.get("resourceProfile") or "standard")])
            build_args.extend(["-t", request["image"], request["context"]])
            docker.cli(*build_args, timeout=1200)
            print("[build] " + request["image"])
        elif action == "seed":
            docker.cli("volume", "create", "qc-" + name + "-data")
            seed_data(docker, "qc-" + name + "-data", request)
        elif action == "activate":
            activate(docker, "qc-" + name, request)
        elif action == "upgrade":
            upgrade(docker, request)
        elif action == "restore":
            restore(docker, request)
        else:
            raise ValueError("Unknown guest action: " + action)


if __name__ == "__main__":
    try:
        request_path = Path(sys.argv[1])
        main(read_bounded_request(request_path), request_path)
    except Exception as error:
        print("[error] " + str(error), file=sys.stderr)
        sys.exit(1)
