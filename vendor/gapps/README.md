# 本地 GApps（不要提交 zip）

MindTheGapps 含 Google 专有组件，**不能进 Git**。放在本目录后，创建 Redroid 实例勾选「预装 Google 套件」会自动选用。

Windows 上 Docker/Redroid 一般是 **x86_64**。官方 **没有** Android 11 的 x86_64 包，默认配对：

| Redroid 镜像 | 本地 zip |
|---|---|
| `redroid/redroid:13.0.0-latest` | `MindTheGapps-13.0.0-x86_64-*.zip` |

下载：

```powershell
.\scripts\fetch-mindthegapps.ps1
```

或手动把 zip 放到本目录。
