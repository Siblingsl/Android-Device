# E-009 — Server-delivered core cleanup

日期：2026-09-17  
范围：Tauri 客户端保存的服务端下发核心文件生命周期。

## 发现

实例列表增强路径下载核心脚本到系统临时目录后，原先只清理了 staging
目录和 guest cache，没有清理下载返回的 `PathBuf`。页面刷新可能因此留下
可复用的本地明文副本。

## 修复与验证

- 新增 `DownloadedCoreCleanup`，在 `spawn_blocking` worker 内拥有临时文件，
  在创建、升级、恢复和列表增强操作返回或 panic 时执行 `remove_file`。
- 先运行新增测试时按预期编译失败：`DownloadedCoreCleanup` 尚不存在。
- 修复后运行：

  `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::downloaded_core_cleanup_removes_plaintext_artifact -- --exact`

  结果：1 个测试通过，0 失败。

## 边界

清理降低了残留文件暴露面，但不能阻止拥有本机管理员权限、Root 或调试器
的攻击者在核心执行期间读取进程内存；绝对保护仍需把最高价值逻辑留在服务端。
