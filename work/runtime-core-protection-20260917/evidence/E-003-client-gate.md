# E-003 — Client-side gate and fail-closed behavior

- Windows 客户端身份私钥由当前用户 DPAPI 保护；客户端公开模型不暴露私钥。
- React 只展示 `AuthorizationRuntimeStatus`；授权校验、租约和 artifact 完整性由 Rust 完成。
- `qemu_redroid_create` 与 `qemu_redroid_upgrade` 在执行前获取 `protected-preset` + `protected-artifact` 和目标 artifact。
- release 构建没有本地 `qemu_guest.py` 的 include fallback；没有服务端核心文件就返回错误。
- 下载文件写入唯一临时路径，验证完整后才交给 guest，操作完成后由调用方删除；成功或失败路径都会移除本地 staging 与 guest cache 中的 runner/request 文件。

残余边界：guest 运行期间必须存在脚本明文，因此管理员/root/调试器提取仍在威胁模型内；最高价值算法不能只放在该脚本。
