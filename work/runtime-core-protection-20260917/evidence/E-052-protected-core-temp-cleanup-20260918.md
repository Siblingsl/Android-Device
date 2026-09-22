# E-052 — 受保护核心临时文件清理（2026-09-18）

## 目的

降低 Tauri 进程在下载或上传受保护 runner 期间异常退出后，Windows 临时目录
遗留明文核心的时间窗口和残留数量。

## TDD 证据

1. 先加入回归测试并执行 focused test；在清理函数尚不存在时，编译按预期失败：
   `cannot find function cleanup_stale_core_artifacts_in`。
2. 增加最小实现后，focused test 通过：最终 runner 文件会被移除，`.part-*` 部分下载
   文件和无关文件保持不变。
3. 清理只在当前进程首次准备受保护核心前执行一次，且只检查系统临时目录的直接子项：
   只接受 `rdc-qemu-guest-*.py` 普通文件，不递归、不跟随非普通文件；扫描或删除失败
   直接 fail closed。

## 全量验证

- `npx tsc --noEmit`：通过
- Vitest：60 文件 / 459 用例通过
- Tauri：283 通过 / 1 忽略
- qemu-center：213 库测试 + 6 CLI 测试通过
- authorization-service：22 库 + 2 管理工具 + 2 启动配置 + 3 集成通过
- guest runner：17/17 Python 测试通过
- release 重建后 `scripts/verify-release-core.ps1`：Tauri 与 qemu-center 均 `clean`

## 边界

这是崩溃残留的文件系统卫生措施，不是安全擦除；runner 为进入 guest 执行，仍必须
短暂以明文存在。最高价值算法继续留在服务端，设备证明和一次性执行票据仍是强制边界。
