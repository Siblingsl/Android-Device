# 设备详情双栏对齐

## 问题

设备详情 Overview 与 Root/伪装在同一 CSS Grid 行中，但 `.detail-overview-panes` 使用 `align-items: start`，两张卡片按自身内容高度渲染，底边不一致。Root 标题栏的操作按钮还允许换行，窄栏时最后一个按钮落到第二行，进一步撑高 Root 卡片。

## 目标

- Overview 与 Root/伪装卡片在同一行保持等高。
- Root 标题栏的操作按钮保持单行，不因换行改变卡片高度。
- 按钮之间使用明确的 flex `gap`，操作组靠右并在极窄宽度下可横向容纳。
- 响应式断点下仍可正常显示，不影响单栏布局。

## 非目标

- 不调整 Root 操作按钮的业务逻辑或可用性。
- 不改变 Overview 数据表格内容。
- 不修改其他页面的通用按钮间距。

## 验收

- CSS 回归断言要求 overview panes 使用 stretch。
- CSS 回归断言要求 Root action row 使用 nowrap、明确 gap 和 overflow 保护。
- Devices/DeviceDetail 相关测试及全量验证通过。
- 实际详情页视觉效果待人工刷新确认。
