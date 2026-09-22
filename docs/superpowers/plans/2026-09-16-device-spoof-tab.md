# 设备详情伪装专用 Tab 实施计划

## 阶段 1：回归测试（先红）

1. 在详情布局测试中要求 Tab 类型、Tab 列表、伪装工作区和两张卡的迁移结构存在。
2. 在 i18n 完整性动态 key 列表中加入伪装 Tab 的中英文 key。
3. 运行定向测试，确认当前实现因缺少独立 Tab 而失败。

## 阶段 2：最小前端实现

1. 扩展 DeviceDetail 的 Tab 类型和 sessionStorage 可恢复列表。
2. 在导航中加入“伪装”Tab，并在工作区渲染 SpoofCard、AuditCard。
3. 从 DeviceSettings 中移除 SpoofCard、AuditCard。
4. 增加伪装 Tab 的中英文名称、工作区说明和纵向满宽样式。

## 阶段 3：完整验证

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `npm run build`
4. `git diff --check`

本轮不改后端；设备详情页最终切换效果待人工刷新确认。
