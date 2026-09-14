# DeviceCloak LSPosed 深度伪装模块（源码，未编译）

这是 RDC 桌面端的「深度伪装」配套 Xposed 模块源码工程。它不在本仓库的 CI / 桌面端
构建链路里编译（桌面端仓库没有 Android SDK / Gradle）；产物需要你在带 Android 环境
的机器上构建一次，再把 APK 放到约定路径，桌面端才能安装它。

**诚实边界**：本模块 hook 的是 **Java 层 API**。任何直接 `dlopen` 读 `/proc`、
`/sys`、自行调用 native GL/传感器接口的检测，都不在本模块保护范围内。它能挡住的是
「普通 App 通过 Android 公开 Java API 读取身份/GL/传感器」这一类识别。

## 目录结构

```
vendor/lsposed-module/
  settings.gradle
  build.gradle
  gradle.properties
  app/
    build.gradle
    src/main/
      AndroidManifest.xml
      assets/xposed_init          # 注册的 hook 类
      java/dev/rdc/devicecloak/
        MainHook.java             # IXposedHookLoadPackage 入口 + 配置加载
        CloakConfig.java          # /data/local/tmp/rdc-cloak.json 解析
        GlHooks.java              # GL_RENDERER / GL_VENDOR / GL_VERSION / GL_EXTENSIONS
        SensorHooks.java          # 缺失传感器占位 + 物理生成读数 + 回放
        ProcMaskHooks.java        # /proc/cpuinfo 等路径重定向，遮蔽 x86 特征
        TelephonyHooks.java       # IMEI/MEID/operator/line1/sim 稳定伪值
        IdHooks.java              # ANDROID_ID 稳定 16 位 hex
        WidevineHooks.java        # MediaDrm device_unique_id / security_level
        GaidHooks.java            # 广告 ID（GAID）稳定 UUID 化
        GsfHooks.java             # GSF ID（best-effort，默认关闭）
        UsagestatsHooks.java      # UsageStatsManager 使用基线合成（配合桌面端播种）
  dist/                            # 构建产物（gitignore，不进 Git）
    RDC-DeviceCloak.apk           # 构建后拷到这里的约定路径
```

## 构建

任选其一（本环境未验证，需 Android SDK + Gradle）：

```bash
# 方式一：Android Studio 打开 vendor/lsposed-module，点 Build > Build APK(s)
# 方式二：命令行（若仓库里没有 gradle wrapper，先执行一次）
cd vendor/lsposed-module
gradle wrapper --gradle-version 8.7      # 生成 gradlew（可选）
./gradlew assembleRelease                 # 或 gradlew.bat assembleRelease（Windows）
```

产物路径：`vendor/lsposed-module/app/build/outputs/apk/release/app-release.apk`。
请把产物复制/重命名为：

```
vendor/lsposed-module/dist/RDC-DeviceCloak.apk
```

桌面端后端会从这个约定路径读取 APK（`services/cloak.rs` 的
`cloak_module_apk_path()`）。`dist/` 已 gitignore（模式同 `vendor/magisk`）。

## 在实例内启用（必须手动做一次）

1. 桌面端「设备详情 → 深度伪装（DeviceCloak）」点「安装模块」（或创建实例时勾选
   「深度伪装」由创建流程自动安装）。
2. 打开实例内 LSPosed 管理器：**模块列表 → DeviceCloak → 启用**。
3. **作用域**里勾选需要伪装的目标 App（例如目标检测 App）。
4. 重启目标 App（或重启实例）使 hook 生效。

桌面端无法代替你在 LSPosed 管理器里点这两下——LSPosed 的启用/作用域是 App 内交互，
没有稳定的命令行开关。

## 配置文件 `/data/local/tmp/rdc-cloak.json`

模块加载时优先读该文件覆盖默认值；没有则用内置默认值。桌面端
「推送配置」会按伪装档案生成它：

```json
{
  "gl": {
    "renderer": "Adreno (TM) 740",
    "vendor": "Qualcomm",
    "version": "OpenGL ES 3.2 V@0615.73"
  },
  "telephony": {
    "operator": "46000",
    "operator_name": "China Mobile"
  }
}
```

可覆盖字段：`gl.renderer / gl.vendor / gl.version`（GL 字符串）、
`telephony.operator`（MCC+MNC）、`telephony.operator_name`、
`widevine.security_level`（默认 `"L3"`，见下文风险说明）、
`gaid.limit_ad_tracking`（默认 `false`）、`gsf.enabled`（默认 `false`）、
`sensors.gravity / sensors.noise / sensors.field_ut / sensors.light_base`
（传感器生成参数）、`usage.seededDays`（使用基线播种窗口天数，默认 `90`）。
IMEI / ANDROID_ID / GAID / Widevine ID / GSF ID 由模块
按设备 serial 哈希稳定生成，不写在配置里。

## 使用基线：UsagestatsHooks 与桌面端播种

全新容器的 `UsageStatsManager` 返回「刚安装、从未使用」——是显著的零历史特征。
直接写 `/data/system/usagestats` 不可行（目录由 system server 重建，写入无效），
所以分两层完成：

1. **桌面端播种**（`services/usage.rs`，详情页「播种使用基线」按钮）：
   - 把按品牌分布的 30-60 个常见 App 包名清单写到
     `/data/local/tmp/rdc-cloak/usage-pkg-list`（每行一个包名）；
   - 同目录附 `usage-README.txt` 操作说明；
   - 对 /sdcard 标准目录（DCIM/Download/Alarms 等）做 `touch -t` 回拨
     （2-180 天，per-dir 稳定）——这是文件时间戳基线。
2. **模块内消费**（`UsagestatsHooks`，目标 App 进程内）：
   hook `UsageStatsManager#queryUsageStats` / `queryEvents(long,long)`，
   在真实返回之上叠加清单内包名的合成记录：安装时间落在最近
   `usage.seededDays`（默认 90）天的偏早区间，最后使用时间偏近，
   **per-package 稳定**（由 serial+包名哈希决定，不随查询变化）；真实记录
   优先，从不覆盖。

已知边界：

- 只覆盖 Java 层 `UsageStatsManager` 读取路径；无参 `queryEvents()`（固定 7 天
  窗口）不 hook，风控 SDK 实际调用的都是双参重载；
- 合成依赖 `UsageStats` / `UsageEvents.Event` 的内部字段（反射），在字段改名或
  移除的 Android 版本上**静默降级**（跳过该字段 / 返回原值），不会让宿主 App
  崩溃；
- `dumpsys usagestats`（shell 层）看不到合成记录——对抗自检审计读的是 shell 层
  证据，两者互不矛盾。

## 传感器：物理生成与回放

`SensorHooks` 在占位传感器之外，会在 App 注册监听器后按传感器声明率注入合成
`SensorEvent`：

- 加速度：重力 9.81 向上 + 噪声 + 偶发脉冲；陀螺仪近零漂移并与脉冲耦合；
- 磁力计 ≈45 µT 场强 + 航向缓变；光感有界随机游走；接近为二值 + 保持时间。

生成参数可用 `sensors.*` 配置覆盖。

**回放模式**：当 `/data/local/tmp/rdc-cloak/sensors.jsonl` 存在时优先回放
（循环）。每行一条 JSON：

```json
{"t": 0.0, "type": 1, "values": [0.12, -0.03, 9.79]}
```

- `t`：相对起始秒数（浮点），文件内递增；播放到 `t_max` 后从头循环。
- `type`：传感器类型 int（1 加速度 / 2 磁力 / 4 陀螺仪 / 5 光感 / 8 接近）。
- `values`：与该传感器维度一致的数组。
- 某类型没有行 → 该类型回退到生成模式。

**采集工具不在本仓库内**：目前需要在真机上自行录制（例如临时写一个
SensorListener 把 `timestamp/values` 按上述格式落盘）。注入方式是直接调用
App 的监听器回调，不经过系统传感器管线——`dumpsys sensorservice` 的事件计
数与 native 侧轮询看不到这些事件。

## Widevine / GAID / GSF 的边界

- **Widevine**：hook `MediaDrm` 的属性读取（注意真实 API 的
  `getPropertyByteArray/getPropertyString` 不带 sessionId——是按属性名读取的
  全局属性，构造器无需 hook）。`security_level` 默认 `"L3"`。**风险**：配成
  `"L1"` 后红丸容器没有任何 TEE / 硬件密钥，一旦目标做 attestation 或与
  服务端历史记录比对，L1 声明反而成为特征。
- **GAID**：`AdvertisingIdClient` 由 play-services 静态打进各 App，App 进程
  内 hook 可行；若未来 Play services 改为动态下发该类，本 hook 会静默跳过。
- **GSF ID**（默认关闭，`gsf.enabled=true` 才生效）：实际存储在
  com.google.android.gsf 的 gservices.db（key `android_id`），Java 层常见读
  取是 gservices provider query 与 `Settings.Secure#getStringForUser`。本
  hook 只覆盖这两条路径，且**作用域必须包含 com.google.android.gsf /
  com.google.android.gms / com.android.vending** 才可能起效。**根本局限**：
  GSF ID 与 Google 账号登录绑定，服务端以账号侧记录为准，单靠 hook 覆盖有
  限，**建议每实例独立账号**，而不是依赖 GSF 伪装。

## 各 hook 族作用与局限

| Hook 族 | 作用 | 局限 |
| --- | --- | --- |
| `GlHooks` | 拦截 `GLES20.glGetString` / `EGL14.eglGetQueryString` 的 GL_RENDERER / VENDOR / VERSION / EXTENSIONS | native 直接读 `/proc` 或调 driver 接口看不到 |
| `SensorHooks` | `getSensorList` / `getDefaultSensor` 补充缺失的加速度/陀螺仪/磁力/光感/接近传感器；注册监听器后按声明率注入物理生成（或回放文件）的 `SensorEvent` | 事件由直接回调注入，不经系统传感器管线；`dumpsys sensorservice` 计数与 native 轮询看不到 |
| `ProcMaskHooks` | `File#canRead/isFile`、`FileInputStream`、`Runtime.exec` 对 `/proc/cpuinfo` 等重定向到本地伪造文件 | 只覆盖 Java 层文件读取，`syscall` 直读不覆盖 |
| `TelephonyHooks` | `getDeviceId/getImei/getMeid/getSimOperator(…)/getLine1Number/getSimSerialNumber` 返回稳定伪值 | 部分检测用 `getPhoneType`/`getSubscriberId` 之外的接口 |
| `IdHooks` | `Settings$Secure.getString(resolver, "android_id")` 返回按 serial 哈希的 16 位 hex | 直接读数据库或 native 读取不覆盖 |
| `WidevineHooks` | `MediaDrm.getPropertyByteArray` 的 device_unique_id/widevine_id 返回稳定 32 字节；`getPropertyString("security_level")` 读配置（默认 L3） | native 直连 DRM HAL 绕过；L1 声明与真实 TEE 缺失矛盾，见上文风险 |
| `GaidHooks` | `AdvertisingIdClient.getAdvertisingIdInfo` 返回按 serial 哈希的 UUID v4 形态 ID + 配置的 limitAdTracking | 类随 play-services 打包，若改为动态下发则 hook 静默跳过 |
| `GsfHooks` | gservices provider query 与 `Settings$Secure.getStringForUser` 的 android_id 返回稳定 16 位 hex（默认关闭） | 服务端以 Google 账号记录为准，作用域必须含 GSF/GMS；覆盖有限，建议每实例独立账号 |
| `UsagestatsHooks` | `UsageStatsManager#queryUsageStats / queryEvents` 叠加按桌面端播种清单合成的基线记录（安装/最后使用时间在 seededDays 窗口内、per-package 稳定） | 只在作用域内 App 进程生效；依赖内部字段反射，字段缺失时静默降级；`dumpsys usagestats` 与 native 轮询不覆盖 |

## 注意事项

- `xposed_init` 里每行一个类名，必须与包名一致。
- 模块 `applicationId` / 包名固定为 `dev.rdc.devicecloak`，桌面端靠这个包名做状态
  检测（`pm list packages dev.rdc.devicecloak`）。
- 经典 Xposed API 依赖为 `compileOnly "de.robv.android.xposed:api:82"`，不打包进 APK。
