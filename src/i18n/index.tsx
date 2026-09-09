import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "../stores/appStore";
import { enDict, zhDict, type Lang } from "./static";

export type { Lang } from "./static";
export { tStatic } from "./static";

const STORAGE_KEY = "rdc.lang";

function readInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en-US" || saved === "zh-CN") return saved;
  } catch {
    /* ignore */
  }
  try {
    if (navigator.language?.toLowerCase().startsWith("en")) return "en-US";
  } catch {
    /* ignore */
  }
  return "zh-CN";
}

type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const value = useMemo<I18nValue>(() => {
    const dict = lang === "en-US" ? enDict : zhDict;
    const fallback = zhDict;
    return {
      lang,
      setLang: (next: Lang) => {
        setLangState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* ignore */
        }
        // Best-effort persistence to backend settings (unavailable in web preview)
        if (settings) {
          void saveSettings({ ...settings, language: next }).catch(() => {
            /* ignore */
          });
        }
      },
      t: (key, vars) => {
        let s = dict[key] ?? fallback[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            s = s.replaceAll(`{${k}}`, String(v));
          }
        }
        return s;
      },
    };
  }, [lang, settings, saveSettings]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) {
    // Fail soft: identity t() keeps pages rendering without a provider.
    return {
      lang: "zh-CN",
      setLang: () => {},
      t: (key, vars) => {
        let s = zhDict[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
        return s;
      },
    };
  }
  return v;
}
