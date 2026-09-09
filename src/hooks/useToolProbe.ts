import { useCallback, useState } from "react";
import { DeviceService } from "../services/deviceService";
import { tStatic } from "../i18n/static";

export type ToolKind = "docker" | "adb" | "scrcpy";

export type ProbeHit = { ok: boolean; text: string };

export async function probeTool(kind: ToolKind, path?: string): Promise<ProbeHit> {
  const bin = path?.trim() || kind;
  try {
    const r = await DeviceService.probeTool(kind, bin);
    return {
      ok: r.success,
      text: r.success ? r.stdout || tStatic("common.tool.available") : r.stderr || r.stdout || tStatic("common.tool.unavailable"),
    };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

export function useToolProbe() {
  const [tools, setTools] = useState<Partial<Record<ToolKind, ProbeHit>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const probe = useCallback(async (kind: ToolKind, path?: string) => {
    setBusy(kind);
    const hit = await probeTool(kind, path);
    setTools((prev) => ({ ...prev, [kind]: hit }));
    setBusy(null);
    return hit;
  }, []);

  const probeMany = useCallback(async (items: { kind: ToolKind; path?: string }[]) => {
    setBusy("all");
    const next: Partial<Record<ToolKind, ProbeHit>> = {};
    let ok = 0;
    for (const item of items) {
      const hit = await probeTool(item.kind, item.path);
      next[item.kind] = hit;
      if (hit.ok) ok += 1;
      setTools((prev) => ({ ...prev, [item.kind]: hit }));
    }
    setBusy(null);
    return { ok, total: items.length, tools: next };
  }, []);

  return { tools, busy, probe, probeMany, setTools };
}
