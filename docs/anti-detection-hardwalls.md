# 反检测硬墙与真机池分流

> 本文是 RDC（Redroid Device Center）伪装能力边界的如实说明，面向运维与风控对抗
> 评估。所有结论对应仓库当前实现：`vendor/magisk-overlay`（boot 期属性伪装）、
> `vendor/zygisk-module`（native 注入）、`vendor/lsposed-module`（DeviceCloak，
> Java 层深度伪装）、`services/audit.rs`（对抗自检审计）与 Devices 页的
> 「云机/真机」筛选。

---

## 一、三面硬墙：为什么有些检测在红丸容器里挡不住

### 硬墙 1：硬件密钥证明（Remote Key Attestation）不可伪造

Android 的硬件级 attestation 中，签名私钥烧录在 SoC 的 TEE（如高通 QSEE /
Trusty）里，私钥**不可导出**；attestation 证书链的根是厂商密钥，向上由
Google（`attest.google.com`）或芯片厂背书。服务端校验时可以做到：

1. 验证证书链签名直到可信根；
2. 检查证书里的 `attestationChallenge` / 安全等级（`KM_SECURITY_LEVEL_TRUSTED_ENVIRONMENT`）；
3. 检查证书链是否在 Google 撤销列表（CRL）里。

红丸容器运行在 x86 主机上，**没有 TEE，更没有厂商硬件私钥**。无论用户态怎么
hook，都无法产出一條能通过签名验证的硬件级证书链。软件级（`KM_SECURITY_LEVEL_SOFTWARE`）
attestation 可以伪造，但证书里明确标记为 software，反而自曝。

DeviceCloak 的 `WidevineHooks` 只把 `security_level` 等 Java 层属性报成 L3
（可配 L1，但 README 已注明：L1 声明与无 TEE 的现实矛盾，反成特征）。任何做
key attestation 的目标（银行、支付、部分风控 SDK），硬闯必被识破。

### 硬墙 2：native / syscall 级遮蔽的边界

DeviceCloak 与 Zygisk 模块 hook 的是 **Java 层 API 与少量 libc 路径重定向**。
以下路径不走 hook：

- native 代码直接 `open/read` `/proc/cpuinfo`、`/proc/version`、`/sys/...`
  （`ProcMaskHooks` 只拦 `java.io.File` / `FileInputStream` / `Runtime.exec`）；
- 直接 `dlopen` `libGLESv2` / `libEGL` / DRM HAL 调驱动接口（`GlHooks` 只拦
  `GLES20` / `EGL14` 的 Java 入口）；
- NDK 原生传感器 API（`ASensorManager`）轮询；
- 自实现的 `/proc` 组合指纹（读 cgroup、mountinfo、sched、stat 的方式与内容）。

要覆盖这些路径，需要在容器内做 syscall 拦截（LSPosed 不能）、seccomp 重写或
内核模块——而红丸容器**共享主机内核、没有内核控制权**，Docker 里挂内核模块即
是主机的内核模块，风险与复杂度完全不可控。`cleanTraces`（bind-mount 伪造
`/proc/cpuinfo`、`/proc/version` + cgroup parent）能挡住最常见的一批直读，但
挡不住对照 mountinfo / `/proc/self/mountinfo` 的深扫。

### 硬墙 3：主机内核字符串的深度审计

容器进程看到的内核是主机的内核：`/proc/version` 的编译者与版本串、cgroup 层级
里的 `docker` 字样、`/sys/class/net/` 只有 eth0 没有 wlan0、`/sys/devices`
设备树缺少手机硬件节点、甚至 eBPF 统计的行为特征，都属于**内核—用户态共享表
面**。用户态伪装可以改字符串（bind-mount、hook），但改不了结构性的差异组合；
深度审计（多个表面交叉比对）在数学上总有残余信息。

`services/audit.rs` 的对抗自检把这一层做成可见清单（cgroup / cpuinfo /
version / SurfaceFlinger GLES / 传感器 / 网卡），**审计读的就是 shell 层证据**
——这恰是绕不过硬墙 2/3 的部分；Java 层伪装效果（DeviceCloak 作用域内的目标
App 视角）必须在目标 App 内实测。

---

## 二、为什么不建议在 redroid 上硬闯强对抗目标

1. **对抗面不对称**：服务端风控只需一次交叉比对命中，本地伪装要覆盖全部表面。
   硬墙 1（attestation）更是零解。
2. **指纹副作用**：hook 越多越厚，反而制造新特征（如 L1 声明无 TEE、SwiftShader
   渲染器 + 旗舰指纹的矛盾组合）。`audit.rs` 的 `gl` / `sensors` 检查项就是为此。
3. **封号成本**：设备指纹被拉黑后，同镜像同配置的新实例继承劣迹；GSF ID 还与
   Google 账号绑定（`GsfHooks` 只覆盖 Java 层读取路径，服务端以账号侧记录为准，
   单靠 hook 覆盖有限——每实例独立账号才是可靠隔离）。
4. **稳定性**：深度 hook 与真机行为差异会导致目标 App 崩溃 / 风控软拒（能跑但
   静默降权），排障成本高。

结论：**强对抗业务上真机，批量长尾业务留在云机**，这是产品层给出的方案。

---

## 三、真机池分流操作建议（配合 Devices 页「云机/真机」筛选）

Devices 页工具栏新增 3 态筛选（判定：`containerId` 非空 = 云机；空 = 真机/LAN）：

- **仅云机**：查看全部 redroid 实例。批量伪装档案轮转、批量代理分流、
  DeviceCloak 安装/推送都在这一档做——云机间保持档案多样性（同一档案不要被
  过多实例复用，批量伪装面板的指纹重复度告警会提示）。
- **仅真机**：查看物理 / LAN 设备池。强对抗目标（含 attestation 校验）分派到
  这一档；真机本身有真实 TEE、传感器与内核，审计的 cgroup/cpuinfo/GLES 各项
  天然 pass。
- **运行审计**：对每台候选设备先跑「对抗自检审计」（设备详情 → 设置 → 对抗自
  检审计），fail 项与目标的风控强度对照后再上业务；云机实例的 fail 属预期
  （见硬墙 2/3），真机的 fail 才是配置问题。

分流原则：同账号 ↔ 同设备类型绑定；云机实例不要中途切换到真机账号体系（反之
亦然）；每实例独立的伪装档案 + 独立代理出口 + 独立账号，三者一起构成隔离单元。

---

## 八层伪装能力对照表（当前实现状态）

| # | 层 | 承载组件 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 系统属性 / 构建指纹 | `vendor/magisk-overlay` spoof.conf（boot 期 set/del）、`services/spoof.rs` 热切换 | ✅ 可用 | 10 个内置档案 + 真机采集档案；一致性由 cargo 测试保证 |
| 2 | 容器痕迹（cgroup/proc 直读） | `cleanTraces`：bind-mount 伪造 cpuinfo/version + `--cgroup-parent` | ⚠️ 部分 | 挡常见直读；mountinfo 深扫、shell 自身 cgroup（审计可见）挡不住 |
| 3 | GL 字符串 | bind-mount + DeviceCloak `GlHooks` | ⚠️ 部分 | Java 层可用；SurfaceFlinger（审计可见）与 native 直调驱动仍在。创建时勾选「GPU 透传」可让 SurfaceFlinger 报告宿主 GPU（需宿主具备直通条件，见下文「宿主侧部署建议」） |
| 4 | 传感器 | DeviceCloak `SensorHooks`：占位 + 物理生成 + JSONL 回放 | ⚠️ 部分 | App 进程内读数可用；不经系统管线，`dumpsys sensorservice` 计数与 NDK 轮询不可见 |
| 5 | 电话身份 | DeviceCloak `TelephonyHooks`（IMEI/MEID/LAC/运营商） | ⚠️ 部分 | 稳定伪值；无真实 SIM/基带，涉网校验不覆盖。**telephony.registry（`dumpsys telephony.registry` 的 mCallState/mServiceState）是 telephony 服务内存态，shell/resetprop 层不可伪装，Java 层 hook 是正确层级**——强风控若直读本层为已知缺口（审计如实标注 unknown） |
| 6 | 设备 ID（ANDROID_ID/GAID/Widevine/GSF） | `IdHooks` / `GaidHooks` / `WidevineHooks` / `GsfHooks`（默认关） | ⚠️ 部分 | 均 per-serial 稳定；GSF 与 Google 账号绑定、建议独立账号；attestation 见硬墙 1 |
| 7 | 电池/遥测曲线 | `services/battery.rs`（确定性状态机）+ `dumpsys battery set` | ✅ 可用 | 100→15 约 14h、15→100 约 2.5h 循环，相位按 serial 错开；AOSP shell 不支持 temperature，未做 |
| 8 | native / syscall 层 | —— | ❌ 硬墙 | 见硬墙 2/3；需要内核侧方案，红丸容器内不可行 |

配套工具：

- **对抗自检审计**（`adversarial_audit` / 设备详情卡片）：cgroup、qemu 属性、
  cpuinfo、内核版本串、SurfaceFlinger GLES、传感器存在性、构建指纹、
  security_patch、网卡名、net.hostname、DNS 存在性、telephony.registry 信令态
  十二项 shell 层证据，pass/fail/unknown 三态 + 实测值；按分类分组输出。
- **电池伪装**：详情页开关（draft 持久化）+ 每 5 分钟自动应用（全局开关在设
  置页，默认开）。
- **云机/真机筛选**：Devices 工具栏，判定 `containerId` 非空。

---

## 四、宿主侧部署建议（应用层刻意不做的事）

以下配置属于**部署环境**（宿主 iptables / Docker 网络层），放在应用层做反而会
制造新特征或要求 root 宿主；RDC 应用内只负责实例级参数（`--hostname`、
`--dns` 轮转、GPU 透传开关），这一层由部署方按机房实际情况配置。

### 1. TTL 归一化（iptables mangle，不在应用层）

移动设备的出向 TTL 集中在 57–64（Android 热点为 63/64），而 Docker 容器经
桥接网络转发一跳，出口 TTL 是宿主 TTL 减 1——「TTL=63」这类细节会被强风控
与 TTL 表记录比对。做法是在宿主（或 WSL2 发行版内）的 mangle 表把出向 TTL
统一改写：

```bash
# 宿主 iptables（docker0 出向、经 FORWARD 链转发的流量统一改写为 64）
iptables -t mangle -A POSTROUTING -s 172.17.0.0/16 -o eth0 -j TTL --ttl-set 64
# nftables 等价：
# nft add rule ip mangle postrouting ip saddr 172.17.0.0/16 oifname "eth0" ip ttl set 64
```

为什么放在部署层而不是应用层：

- TTL 由**内核转发路径**决定，容器内用户态（netfilter 权限被裁剪、无内核模块
  加载能力）改不了自己的出向 TTL——这与硬墙 2/3 同源：容器没有内核控制权；
- 每个部署环境的子网/出口网卡/基准 TTL 不同（真机池基准可能是 64，云上可能
  要求 57），只能由部署方按实际情况固化成开机脚本，应用层硬编码反而是错
  的；
- 若宿主本身就是云厂商的 NAT 网关，TTL 改写应挂在网关侧，与 RDC 无关。

### 2. GPU 透传的前提与 WSL2 限制

创建表单的「GPU 透传」会让 `docker run` 追加
`androidboot.redroid_gpu_mode=host` 并挂载宿主 GPU 节点（`--device /dev/dri`），
把 SurfaceFlinger 报告的 SwiftShader 软渲染换成宿主 GPU（gfxstream/host 渲
染）——审计的 gl 检查从 fail 转 pass，也消除「旗舰指纹 + SwiftShader」的矛盾
组合。但前提必须如实说明：

- **宿主必须有可用 GPU 直通环境**：Linux 宿主需要 `/dev/dri`（DRM/KMS 节点，
  即加载了显卡驱动的内核）；`docker run` 只是拼参数，节点不存在时容器直接
  起不来，错误由 docker 原样返回；
- **Windows + Docker Desktop 的宿主实际是 WSL2 VM**：`/dev/dri` 在 WSL2 内核
  里是否存在**因机器而异**——需要 WSL2 内核启用 GPU-PV（/dev/dxg +
  /dev/dri 的映射依赖内核版本与驱动，自定义 binder 内核尤其如此），默认
  Microsoft 内核在部分机器上可以、部分不行。勾选前先在 WSL2 里确认
  `ls /dev/dri` 有输出；
- 没有直通条件时**不要勾选**：guest 模式（SwiftShader）虽然会被审计判为软渲
  染特征，但至少能开机；host 模式 + 无 GPU 节点 = 容器创建失败。

### 3. 每实例网络参数（应用内已做，此处备案）

- `--hostname`：按伪装档案 brand 派生（≤15 字符 + adbPort 后两位后缀），消除
  Docker 默认 12 位 hex 短 ID 特征；
- `--dns`：勾选痕迹清理时按 adbPort % 3 从 1.1.1.1 / 8.8.8.8 / 9.9.9.9 轮转，
  避免全宿主实例共享单一 resolver。若部署环境要求私有 DNS（如自建
  DoH 网关），在部署层整体覆盖即可。
