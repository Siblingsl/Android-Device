# QEMU instance presets

Approved scope: 补齐创建页全部选项＋现有实例升级入口.

Creation supports Android image/version, local x86_64 GApps, Magisk + Zygisk, LSPosed, Shamiko, additional module zips, DeviceCloak, native cloak, device profile/custom spoof.conf, ABI and target-package options, and guest-side trace configuration. Prepare assets locally and build images inside the node without host Docker Desktop. Validate versions, architecture and dependencies before changing an instance. Surface real installation failures.

Upgrade keeps the same Android version and existing runtime settings, stops the instance only after image preparation, clones its data volume, retains the old container/data for rollback, and restores the old instance on activation failure. Provide an explicit restore entrance. Merely adding this entrance does not authorize upgrading the user's current r1 automatically.

After first boot, trust the host ADB key, wait for the preset completion marker, restart to activate Zygisk, and verify daemon, configured Zygisk, loaded Zygisk, selected modules, requested apps and profile. DeviceCloak requires manual LSPosed scope activation; communicate that result accurately.

Do not push or commit the feature without a further request. Keep downloaded assets, guest state and keys out of Git.
