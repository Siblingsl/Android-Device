# Redroid Device Center（桌面客户端）

## 产品规划与开发设计文档（V1.0）

---

# 一、项目定位

## 产品名称（暂定）

Redroid Device Center

## 产品定位

一款面向 Android 自动化开发、AI Agent、云手机控制、App 自动化测试的桌面管理平台。

产品采用：

* Tauri 2.0
* React
* TypeScript
* Docker
* Redroid
* scrcpy
* ADB

作为底层能力。

整个产品采用桌面客户端模式。

后续可扩展：

* AI Agent
* 自动化流程
* 云手机平台
* 多设备管理
* 多账号管理
* SaaS部署

---

# 二、开发原则

整个项目遵循以下原则：

## 第一原则

先实现稳定控制。

不要为了 AI 而开发 AI。

所有 AI 能力，都必须建立在：

"设备稳定可控"

这一基础能力之上。

---

## 第二原则

能力全部模块化。

所有控制能力必须封装成统一接口。

例如：

截图

点击

输入

滑动

安装APK

启动APP

停止APP

获取日志

均不能散落在页面中。

统一由 Device Service 提供。

---

## 第三原则

UI 与逻辑彻底分离。

React：

负责页面

Tauri：

负责系统能力

Backend：

负责ADB、Docker、scrcpy

以后替换底层实现，不影响UI。

---

# 三、技术架构

Client（React）

↓

Tauri IPC

↓

Device Service

↓

Docker

ADB

scrcpy

Redroid

---

# 四、整体UI设计规范

整体风格：

现代专业工具软件。

参考：

Docker Desktop

Raycast

Cursor

Linear

Arc Browser

Android Studio Device Manager

整体风格：

大量留白

卡片布局

圆角

毛玻璃

轻阴影

浅灰背景

深色主题可切换

---

# 动效规范

所有页面：

必须拥有自然动画。

禁止页面瞬间切换。

建议：

Framer Motion。

动画统一：

200~300ms

缓出

不能夸张。

---

# 页面切换

左侧菜单

切换

内容淡入

+轻微位移

---

# 卡片

Hover：

阴影提升

轻微放大

1%

---

# 按钮

Hover：

背景渐变

阴影增强

Press：

缩放95%

---

# Loading

全部Skeleton。

禁止Loading文字。

---

# 五、页面结构

左侧：

导航栏

中间：

工作区

右侧：

详情面板（可折叠）

底部：

状态栏

---

导航：

Dashboard

Devices

APK

Logs

Settings

后续：

Automation

AI

Workflow

Marketplace

---

# 六、一期（MVP）

目标：

打造完整设备控制平台。

不是AI平台。

---

## 一、Dashboard

作用：

快速查看整个系统状态。

内容：

Docker状态

ADB状态

在线设备数量

CPU

内存

实时FPS

最近日志

最近截图

最近APK

系统通知

设计：

顶部：

统计卡片

中间：

设备状态

底部：

日志

---

## 二、设备中心（Devices）

这是整个系统核心。

---

设备列表

左侧：

设备卡片。

每张卡片：

设备名称

Android版本

在线状态

CPU

RAM

FPS

ADB状态

Scrcpy状态

Docker状态

IP

启动时间

按钮：

连接

断开

重启

停止

更多

---

点击设备：

进入详情。

---

设备详情

分为：

Overview

Control

Files

Apps

Logs

Settings

---

Overview

显示：

设备信息

分辨率

Android版本

CPU

RAM

IP

MAC

ADB

Scrcpy

Docker

容器ID

镜像版本

运行时间

---

Control

整个页面分左右。

左侧：

实时画面。

右侧：

控制栏。

---

实时画面

基于：

scrcpy。

要求：

低延迟。

支持：

缩放

全屏

旋转

截图

录屏

刷新

断开重连

FPS显示

码率显示

网络延迟

---

控制栏

提供：

HOME

BACK

RECENT

POWER

VOLUME

锁屏

亮屏

旋转

输入文本

发送剪贴板

打开通知栏

打开设置

---

鼠标控制

支持：

点击

双击

长按

拖动

滑动

滚轮

多点模拟（预留）

右键返回

中键HOME

快捷键映射

---

ADB控制

支持：

Shell

输入命令

执行历史

命令收藏

命令输出

复制结果

导出日志

---

APK管理

支持：

安装APK

批量安装

覆盖安装

卸载

启动

停止

查看版本

查看权限

查看Activity

查看Package

---

截图

支持：

实时截图

延迟截图

连续截图

保存目录

复制剪贴板

打开目录

---

日志

支持：

实时Logcat

暂停

过滤

关键字搜索

颜色高亮

导出TXT

自动滚动

清空日志

---

Files（文件管理）

支持：

浏览目录

上传文件

下载文件

删除

新建文件夹

拖拽上传

显示容量

---

Apps（应用管理）

支持：

应用列表

包名

版本

大小

首次安装

更新时间

启动

停止

卸载

清缓存

清数据

查看权限

---

Settings

支持：

分辨率

DPI

语言

ADB端口

Scrcpy参数

容器参数

自动启动

---

## 三、Docker管理

独立页面。

支持：

Docker是否运行

版本

镜像

容器

资源占用

---

Redroid实例

支持：

创建实例

启动

停止

删除

重启

克隆

重命名

查看配置

导出配置

导入配置

---

创建实例

支持：

Android版本

CPU

RAM

分辨率

DPI

ADB端口

Scrcpy端口

镜像版本

名称

---

## 四、ADB管理

支持：

扫描设备

自动连接

手动连接

断开

重连

ADB版本

Server状态

自动修复

---

## 五、系统日志

支持：

系统日志

ADB日志

Docker日志

Scrcpy日志

错误日志

搜索

导出

---

## 六、设置

主题

语言

自动更新

日志路径

截图路径

APK路径

代理

Docker路径

ADB路径

Scrcpy路径

关于

许可证

---

# 一期开发目标

完成后必须达到：

可以启动多个Redroid。

可以连接ADB。

可以实时控制。

可以安装APK。

可以查看日志。

可以截图。

可以操作Android。

整个客户端能够长期稳定运行。

这一阶段不涉及AI能力。

---

# 七、二期（AI + 自动化）

目标：

把一期所有能力变成可编排能力。

一期负责：

"人控制"

二期负责：

"AI控制"

---

## Automation Center

新增页面。

采用：

流程编排。

节点：

开始

结束

等待

点击

滑动

输入

截图

OCR

条件判断

循环

变量

日志

安装APK

启动APP

停止APP

Shell

HTTP

Webhook

Python（预留）

JavaScript（预留）

AI节点

---

## AI Agent

新增：

聊天窗口。

AI可以：

查看设备。

控制设备。

分析页面。

识别按钮。

生成操作。

执行操作。

---

## OCR

支持：

本地OCR

云OCR

多语言

文本定位

坐标返回

---

## Vision

支持：

图片理解。

自动识别：

按钮

输入框

图片

列表

弹窗

广告

验证码（预留）

---

## Task Scheduler

任务中心。

支持：

立即执行

定时执行

循环执行

失败重试

优先级

暂停

恢复

取消

---

## Device Pool

设备池。

支持：

自动分配设备。

自动回收。

负载均衡。

状态监控。

健康检测。

---

## Multi Device

支持：

批量控制。

同步点击。

同步安装。

同步截图。

同步启动。

同步停止。

---

## API

开放：

REST API

WebSocket

Plugin API

以后：

第三方可直接调用。

---

## Plugin Marketplace

插件系统。

支持：

OCR插件

AI插件

ADB插件

Docker插件

Workflow插件

Scrcpy插件

通知插件

导入导出插件

---

# 八、后续（三期规划）

支持：

远程设备。

Linux部署。

Windows Agent。

Mac Agent。

Docker集群。

Kubernetes。

Redroid集群。

云手机SaaS。

多租户。

账号体系。

权限管理。

团队协作。

AI自动测试。

AI手机助手。

AI运营机器人。

---

# 九、开发里程碑

## Milestone 1：基础框架

* Tauri + React 初始化
* 路由、主题、布局
* 状态管理
* IPC 通信
* 日志系统

交付标准：客户端框架稳定，基础 UI 完成。

---

## Milestone 2：设备能力

* Docker 管理
* Redroid 实例创建/启动/停止
* ADB 管理
* scrcpy 集成
* 实时画面
* 控制指令封装

交付标准：可以完整控制 Android 设备。

---

## Milestone 3：设备管理完善

* APK 管理
* 文件管理
* 日志查看
* 截图与录屏
* 设置管理

交付标准：形成完整的 Device Center。

---

## Milestone 4：二期能力

* 自动化流程
* AI Agent
* OCR
* Vision
* 调度器
* 多设备控制
* 开放 API
* 插件系统

交付标准：由“人工控制平台”升级为“AI 自动化平台”。

---

# 十、最终产品目标

最终产品不是一个简单的 Redroid 管理器，而是一个具备统一设备抽象层（Device Abstraction Layer）的 Android 自动化工作台。

所有设备能力（Docker、Redroid、ADB、scrcpy）均以标准接口形式向上提供服务；AI、自动化流程、插件、外部 API 仅依赖这些统一接口，而不直接依赖底层实现。

这样可以保证未来无论接入真实 Android 手机、其他云手机方案，还是扩展到大规模设备集群，业务层无需重构，仅替换底层驱动即可完成能力扩展。
