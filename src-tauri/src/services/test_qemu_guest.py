"""Exercise runtime configuration and rollback without a Docker daemon."""
import copy
import os
import sys
import unittest
from unittest.mock import patch

# Some interpreters (e.g. AutoClaw's bundled Python 3.13) start with
# safe_path=True (the -P flag / PYTHONSAFEPATH environment variable), which keeps
# both the script's own directory and PYTHONPATH out of sys.path — so a plain
# `python test_qemu_guest.py` cannot import its sibling module. Bootstrap the
# directory explicitly to keep this file runnable under any interpreter.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import qemu_guest as guest


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
