# -*- coding: utf-8 -*-
# Scan src for leftover user-visible Chinese outside i18n dictionaries.
import io, re, glob, os

pat = re.compile(r'[一-龥]')
allowed_files = {"src/i18n/pages/adb.ts", "src/i18n/pages/apk.ts", "src/i18n/pages/common.ts",
                 "src/i18n/pages/dashboard.ts", "src/i18n/pages/deviceDetail.ts", "src/i18n/pages/devices.ts",
                 "src/i18n/pages/docker.ts", "src/i18n/pages/logs.ts", "src/i18n/pages/settings.ts",
                 "src/i18n/pages/volumes.ts"}
# known intentional leftovers (regexes matching backend Chinese, comments, language self-names)
allowed_snippets = [
    "/未完成|失败/", "切换到简体中文", "日本語", "한국어",
]

for f in sorted(glob.glob("src/**/*.ts", recursive=True) + glob.glob("src/**/*.tsx", recursive=True)):
    nf = os.path.normpath(f).replace("\\", "/")
    if nf in allowed_files:
        continue
    s = io.open(f, encoding="utf-8").read()
    for i, line in enumerate(s.splitlines(), 1):
        m = pat.search(line)
        if not m:
            continue
        stripped = line.strip()
        if stripped.startswith("//"):
            continue
        if any(a in line for a in allowed_snippets):
            continue
        # skip pure comments after code? report anyway but mark
        print(f"{f}:{i}: {stripped[:110]}")
