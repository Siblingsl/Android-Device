"""Node-side preset runner. Python stdlib; Docker only inside the QEMU guest."""
import copy
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote

SDK_VERSIONS = {29: "10", 30: "11", 31: "12", 32: "12", 33: "13", 34: "14", 35: "15", 36: "16"}


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
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError("docker " + args[0] + ": " + result.stderr.strip())
        return result.stdout.strip()

    def inspect(self, name):
        return json.loads(self.cli("inspect", name))[0]

    def exists(self, name):
        return subprocess.run(["docker", "inspect", name], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=30).returncode == 0

    def create(self, name, config):
        connection = UnixHTTP("localhost", timeout=120)
        try:
            connection.request("POST", "/containers/create?name=" + quote(name, safe=""),
                               json.dumps(config), {"Content-Type": "application/json"})
            response = connection.getresponse()
            body = response.read().decode()
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


def details(docker, request):
    rows = []
    for instance in request.get("names") or []:
        name = "qc-" + instance
        if not docker.exists(name):
            continue
        inspected = docker.inspect(name)
        version = ""
        try:
            # Cached immutable version label for derived images; fallback to file probe.
            version = inspected["Config"].get("Labels", {}).get("rdc.qemu.android", "") or device_version(docker, name)
        except (ValueError, RuntimeError):
            pass
        rows.append({"instance": instance, "androidVersion": version, "image": inspected["Config"]["Image"],
                     "rollbackAvailable": docker.exists(name + "-preupgrade")})
    print(json.dumps(rows))


def main(request):
    import fcntl
    name = request.get("name", "")
    if name and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,23}", name):
        raise ValueError("Invalid instance name")
    action = request["action"]
    docker = Docker()
    if action == "details":
        details(docker, request)
        return
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
            docker.cli("build", "--label", "rdc.qemu.android=" + version, "-t", request["image"], request["context"], timeout=1200)
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
        main(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        print("[error] " + str(error), file=sys.stderr)
        sys.exit(1)

