# -*- coding: utf-8 -*-
"""Audit i18n dictionary coverage: missing keys + placeholder mismatches."""
import io, re, glob, os

dict_keys = set()
zh_vals = {}
for f in glob.glob("src/i18n/pages/*.ts"):
    s = io.open(f, encoding="utf-8").read()
    for m in re.finditer(r'"([A-Za-z0-9_.]+)":\s*"((?:[^"\\]|\\.)*)"', s):
        dict_keys.add(m.group(1))
        zh_vals[m.group(1)] = m.group(2)
    # assignment form: xxZh["key"] = "value";
    for m in re.finditer(r'\w+\["([A-Za-z0-9_.]+)"\]\s*=\s*"((?:[^"\\]|\\.)*)"', s):
        dict_keys.add(m.group(1))
        zh_vals[m.group(1)] = m.group(2)

used = {}
files = glob.glob("src/**/*.ts", recursive=True) + glob.glob("src/**/*.tsx", recursive=True)
for f in files:
    nf = os.path.normpath(f).replace("\\", "/")
    if nf.startswith("src/i18n/pages"):
        continue
    s = io.open(f, encoding="utf-8").read()
    for m in re.finditer(r'\bt(?:Static)?\(\s*"([A-Za-z0-9_.]+)"', s):
        used.setdefault(m.group(1), []).append(f)

missing = sorted(k for k in used if k not in dict_keys)
print("total dict keys:", len(dict_keys))
print("total used keys:", len(used))
print("MISSING KEYS:", len(missing))
for k in missing:
    print("  -", k, "<-", used[k][0])

bad = []
for k, flist in used.items():
    val = zh_vals.get(k, "")
    expected = set(re.findall(r'\{([A-Za-z0-9_]+)\}', val))
    for f in flist:
        s = io.open(f, encoding="utf-8").read()
        pat = 't(?:Static)?\\(\\s*"' + re.escape(k) + '"\\s*,\\s*\\{([^{}]*)\\}\\s*\\)'
        for m in re.finditer(pat, s, re.S):
            args = m.group(1)
            passed = set(re.findall(r'([A-Za-z_$][A-Za-z0-9_$]*)\s*:', args))
            rest = re.sub(r'[A-Za-z_$][A-Za-z0-9_$]*\s*:[^,}]*', '', args)
            for tok in re.findall(r'[A-Za-z_$][A-Za-z0-9_$]*', rest):
                if tok not in ("true", "false", "null", "undefined"):
                    passed.add(tok)
            if passed != expected:
                bad.append((k, sorted(passed), sorted(expected), f))
print("PLACEHOLDER MISMATCHES:", len(bad))
for k, p, e, f in bad:
    print("  -", k, "passed:", p, "dict:", e, "in", f)
