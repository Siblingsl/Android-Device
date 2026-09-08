import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "../stores/appStore";
import { commonZh, commonEn } from "./pages/common";
import { dashboardZh, dashboardEn } from "./pages/dashboard";
import { devicesZh, devicesEn } from "./pages/devices";
import { volumesZh, volumesEn } from "./pages/volumes";
import { adbZh, adbEn } from "./pages/adb";
import { apkZh, apkEn } from "./pages/apk";
import { logsZh, logsEn } from "./pages/logs";
import { settingsZh, settingsEn } from "./pages/settings";
import { dockerZh, dockerEn } from "./pages/docker";
import { deviceDetailZh, deviceDetailEn } from "./pages/deviceDetail";
import { monitorZh, monitorEn } from "./pages/monitor";

export type Lang = "zh-CN" | "en-US";

type Dict = Record<string, string>;

const zhDict: Dict = {
  ...commonZh,
  ...dashboardZh,
  ...devicesZh,
  ...volumesZh,
  ...adbZh,
  ...apkZh,
  ...logsZh,
  ...settingsZh,
  ...dockerZh,
  ...deviceDetailZh,
  ...monitorZh,
};
const enDict: Dict = {
  ...commonEn,
  ...dashboardEn,
  ...devicesEn,
  ...volumesEn,
  ...adbEn,
  ...apkEn,
  ...logsEn,
  ...settingsEn,
  ...dockerEn,
  ...deviceDetailEn,
  ...monitorEn,
};

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

/**
 * Standalone lookup for non-React modules (stores, utils) that cannot use
 * the hook. Reads the current language from localStorage; not reactive.
 */
export function tStatic(key: string, vars?: Record<string, string | number>): string {
  let lang: Lang = "zh-CN";
  try {
    if (localStorage.getItem(STORAGE_KEY) === "en-US") lang = "en-US";
  } catch {
    /* ignore */
  }
  const dict = lang === "en-US" ? enDict : zhDict;
  let s = dict[key] ?? zhDict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
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
