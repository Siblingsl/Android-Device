import { describe, expect, it } from "vitest";
import {
  COMPARE_METRIC_LABEL_KEY,
  COMPARE_METRICS,
  NO_SOURCE_METRICS,
  androidVersionKey,
  buildCompareView,
  imageTag,
  instanceRunState,
  instanceVersionLabel,
  noSourceHintKey,
  type CompareHealth,
  type CompareTranslator,
} from "./runtimeCompare";
import { runtimeZh } from "../i18n/pages/runtime";
import type { DockerSourceReading, QemuSourceReading, RuntimeInstanceRow } from "./runtimeTrack";

/**
 * Real zh dictionary as the translator: a key the module forgot to declare then
 * shows up as the key itself in the assertion, and the tests exercise the copy
 * the UI actually renders.
 */
const t: CompareTranslator = (key, vars) => {
  let text = runtimeZh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

const row = (name: string, over: Partial<RuntimeInstanceRow> = {}): RuntimeInstanceRow => ({
  name,
  androidVersion: "",
  image: "redroid/redroid:13.0.0-latest",
  status: "Up 2 minutes",
  host: "",
  ...over,
});

const dockerReading = (
  instances: RuntimeInstanceRow[] | null,
  over: Partial<DockerSourceReading> = {},
): DockerSourceReading => ({
  at: 1_000,
  running: true,
  containers: instances ? instances.length : null,
  cliAvailable: true,
  kernelBinderEnabled: true,
  instances,
  ...over,
});

const qemuReading = (
  instanceRows: RuntimeInstanceRow[] | null,
  over: Partial<QemuSourceReading> = {},
): QemuSourceReading => ({
  at: 2_000,
  nodes: 1,
  instances: instanceRows ? instanceRows.length : null,
  scope: "node1",
  checks: { at: 2_000, total: 8, ok: 8, fail: 0, other: 0 },
  cliError: "",
  instanceRows,
  ...over,
});

const HEALTH: Record<"docker" | "qemu", CompareHealth> = {
  docker: { text: "正常", level: "ok", detail: "" },
  qemu: { text: "体检 8/8（刚刚）", level: "ok", detail: "" },
};

function build(docker: DockerSourceReading | null, qemu: QemuSourceReading | null) {
  return buildCompareView({ docker, qemu }, HEALTH, t);
}

describe("version extraction (spec §6.8 分组维度)", () => {
  it("takes the Android major version out of both tracks' labels", () => {
    expect(androidVersionKey("13.0.0-latest")).toBe("13");
    expect(androidVersionKey("14")).toBe("14");
    expect(androidVersionKey("12.0.0_64only-latest")).toBe("12");
    expect(androidVersionKey("Android 15")).toBe("15");
  });

  it("reports no version when the label carries none", () => {
    expect(androidVersionKey("latest")).toBeNull();
    expect(androidVersionKey("")).toBeNull();
  });

  it("reads the tag of an image reference, not a registry port", () => {
    expect(imageTag("redroid/redroid:13.0.0-latest")).toBe("13.0.0-latest");
    expect(imageTag("localhost:5000/redroid")).toBe("");
    expect(imageTag("redroid/redroid")).toBe("");
  });

  it("prefers the read version over the image tag", () => {
    expect(instanceVersionLabel(row("a", { androidVersion: "14" }))).toBe("14");
    expect(instanceVersionLabel(row("a", { image: "redroid/redroid:14.0.0-latest" }))).toBe(
      "14.0.0-latest",
    );
    expect(instanceVersionLabel(row("a", { image: "redroid/redroid" }))).toBe("");
  });
});

describe("run state from the docker ps Status column", () => {
  it("matches the panels' own isUp rule", () => {
    expect(instanceRunState("Up 2 minutes")).toBe(true);
    expect(instanceRunState("Up 3 hours (healthy)")).toBe(true);
    expect(instanceRunState("Exited (0) 5 hours ago")).toBe(false);
    expect(instanceRunState("Created")).toBe(false);
  });

  it("does not invent a state the guest never reported", () => {
    // `qemu-center redroid list` writes "unknown" when the VM did not answer.
    expect(instanceRunState("unknown")).toBeNull();
    expect(instanceRunState("")).toBeNull();
  });
});

describe("buildCompareView grouping", () => {
  it("puts the same Android version of both tracks in one aligned group", () => {
    const view = build(
      dockerReading([row("rdc-1"), row("rdc-2"), row("rdc-3", { image: "redroid/redroid:14.0.0-latest" })]),
      qemuReading([
        row("qc-1", { androidVersion: "13", host: "node1" }),
        row("qc-2", { androidVersion: "13", status: "Exited (0) 1 hour ago", host: "node1" }),
      ]),
    );

    expect(view.groups.map((group) => group.key)).toEqual(["13", "14"]);
    const thirteen = view.groups[0];
    expect(thirteen.title).toBe("Android 13");
    expect(thirteen.alignment).toBe("aligned");
    expect(thirteen.singleTrack).toBeNull();
    expect(thirteen.sides.docker.instances.map((i) => i.name)).toEqual(["rdc-1", "rdc-2"]);
    expect(thirteen.sides.qemu.instances.map((i) => i.name)).toEqual(["qc-1", "qc-2"]);
    // Raw labels of both tracks are kept as evidence next to the group title.
    expect(thirteen.rawLabels).toEqual(["13", "13.0.0-latest"]);
    // The bars are real ratios: docker 2 of 4 instances, qemu 1 of 2 running.
    expect(thirteen.sides.docker.cells.instances).toEqual({
      kind: "count",
      text: "2",
      share: 0.5,
      note: "",
    });
    expect(thirteen.sides.qemu.cells.running).toEqual({
      kind: "count",
      text: "1 / 2",
      share: 0.5,
      note: "",
    });
  });

  it("lists a version only one track has as 单轨独有", () => {
    const view = build(
      dockerReading([row("rdc-1"), row("rdc-9", { image: "redroid/redroid:14.0.0-latest" })]),
      qemuReading([row("qc-1", { androidVersion: "13", host: "node1" })]),
    );

    const fourteen = view.groups.find((group) => group.key === "14");
    expect(fourteen?.alignment).toBe("single");
    expect(fourteen?.singleTrack).toBe("docker");
    // The other track is *read* and simply has none of this version: a real 0.
    expect(fourteen?.sides.qemu.cells.instances).toEqual({
      kind: "count",
      text: "0",
      share: 0,
      note: "已读取，本组无实例",
    });

    const thirteen = view.groups.find((group) => group.key === "13");
    expect(thirteen?.alignment).toBe("aligned");
  });

  it("refuses to claim 单轨独有 while the other track has no usable snapshot", () => {
    const view = build(
      dockerReading([row("rdc-1")]),
      qemuReading(null, { cliError: "qemu-center not found" }),
    );

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].alignment).toBe("unresolved");
    expect(view.groups[0].singleTrack).toBeNull();
  });

  it("groups instances whose read carries no version under 未标注版本, last", () => {
    const view = build(
      dockerReading([
        row("rdc-1", { image: "rdc/custom" }),
        row("rdc-2", { image: "rdroid/rdroid:14.0.0-latest" }),
      ]),
      null,
    );

    expect(view.groups.map((group) => group.key)).toEqual(["14", "unknown"]);
    expect(view.groups[1].title).toBe("未标注版本");
    expect(view.groups[1].sides.docker.instances.map((i) => i.name)).toEqual(["rdc-1"]);
  });
});

describe("unavailable semantics (spec §6.8: 不得显示 0)", () => {
  const zeroFree = (cell: { kind: string } & Record<string, unknown>) =>
    !("text" in cell) || !String(cell.text).includes("0");

  it("states the reason on both data-backed rows when Docker is not running", () => {
    const view = build(
      dockerReading(null, { running: false, containers: null }),
      qemuReading([row("qc-1", { androidVersion: "13", host: "node1" })]),
    );

    const side = view.groups[0].sides.docker;
    expect(side.available).toBe(false);
    expect(side.cells.instances).toMatchObject({ kind: "unavailable", reason: "Docker 未启动" });
    expect(side.cells.running).toMatchObject({ kind: "unavailable", reason: "Docker 未启动" });
    expect(side.instances).toEqual([]);
    expect(zeroFree(side.cells.instances)).toBe(true);
    expect(zeroFree(side.cells.running)).toBe(true);
    expect(view.summaries.docker.count).toBeNull();
  });

  it("states a missing CLI instead of 0", () => {
    // Both sides unusable: no group can be formed, and the two track summaries
    // carry the reasons that would otherwise be cells.
    const both = build(
      dockerReading([row("rdc-1")], { cliAvailable: false }),
      qemuReading(null, { cliError: "qemu-center not found", instances: null }),
    );

    expect(both.groups).toEqual([]);
    expect(both.summaries.docker).toMatchObject({ count: null, unavailable: "CLI 缺失" });
    expect(both.summaries.qemu).toMatchObject({
      count: null,
      unavailable: "CLI 缺失",
      detail: "qemu-center not found",
    });

    // One side readable, the other not: the group exists and every cell of the
    // missing side states its reason, including the resource metrics.
    const one = build(
      dockerReading([row("rdc-1")]),
      qemuReading(null, { cliError: "qemu-center not found", instances: null }),
    );
    const qemuSide = one.groups[0].sides.qemu;
    expect(qemuSide.cells.instances).toMatchObject({ kind: "unavailable", reason: "CLI 缺失" });
    expect(qemuSide.cells.running).toMatchObject({ kind: "unavailable", reason: "CLI 缺失" });
    expect(zeroFree(qemuSide.cells.instances)).toBe(true);
    expect(qemuSide.cells.cpuQuota).toMatchObject({ kind: "unavailable", reason: "CLI 缺失" });
    expect(one.groups[0].sides.docker.cells.instances).toMatchObject({ kind: "count", text: "1" });
  });

  it("reads a snapshot without instance rows as 未读取, never as 0", () => {
    const view = build(
      // A pre-P6 snapshot or a read that has not landed yet.
      { at: 1_000, running: true, containers: 4, cliAvailable: true, kernelBinderEnabled: true },
      { at: 2_000, nodes: 1, instances: 3, scope: "node1", checks: null, cliError: "" },
    );

    expect(view.summaries.docker.count).toBeNull();
    expect(view.summaries.docker.unavailable).toBe("未读取");
    expect(view.summaries.qemu.count).toBeNull();
    expect(view.summaries.qemu.unavailable).toBe("未读取");
    expect(view.groups).toEqual([]);
  });

  it("does not keep the four resource metrics in the no-source bucket", () => {
    expect(NO_SOURCE_METRICS).toEqual([]);
    for (const metric of ["cpuQuota", "memQuota", "disk", "bootTime"] as const) {
      expect(COMPARE_METRICS).toContain(metric);
      expect(COMPARE_METRIC_LABEL_KEY[metric]).toBeTruthy();
      expect(noSourceHintKey(metric)).toBe(`runtime.compare.gap.${metric}`);
      expect(runtimeZh[noSourceHintKey(metric)]).toBeTruthy();
    }

    const view = build(dockerReading([row("rdc-1")]), null);
    const cells = view.groups[0].sides.docker.cells;
    for (const metric of ["cpuQuota", "memQuota", "disk", "bootTime"] as const) {
      expect(cells[metric]).toMatchObject({
        kind: "unavailable",
        reason: "不可用（本次读取无指标）",
      });
    }
  });

  it("renders read-only resource metrics from the instance snapshot", () => {
    const view = build(
      dockerReading([
        row("rdc-1", {
          metrics: {
            cpuQuotaCores: 2,
            cpuUnlimited: false,
            memoryQuotaBytes: 4 * 1024 * 1024 * 1024,
            memoryUnlimited: false,
            diskBytes: 1024 * 1024,
            startedAt: "2026-09-16T10:00:00.000Z",
            finishedAt: "2026-09-16T10:01:00.000Z",
          },
        }),
      ]),
      null,
    );

    expect(view.groups[0].sides.docker.cells.cpuQuota).toMatchObject({ kind: "value", text: "2 vCPU" });
    expect(view.groups[0].sides.docker.cells.memQuota).toMatchObject({ kind: "value", text: "4 GiB" });
    expect(view.groups[0].sides.docker.cells.disk).toMatchObject({ kind: "value", text: "1 MiB" });
    expect(view.groups[0].sides.docker.cells.bootTime).toMatchObject({ kind: "value", text: "1 分钟" });
  });

  it("keeps unlimited quotas, partial reads, zero disk and running duration explicit", () => {
    const view = buildCompareView(
      {
        docker: dockerReading([
          row("limited", {
            metrics: {
              cpuQuotaCores: 2,
              cpuUnlimited: false,
              memoryQuotaBytes: null,
              memoryUnlimited: true,
              diskBytes: 0,
              startedAt: "2026-09-16T10:00:00.000Z",
              finishedAt: null,
            },
          }),
          row("partial", { metrics: null }),
        ]),
        qemu: null,
      },
      HEALTH,
      t,
      Date.parse("2026-09-16T10:02:00.000Z"),
    );

    const cells = view.groups[0].sides.docker.cells;
    expect(cells.cpuQuota).toMatchObject({ kind: "value", text: "2 vCPU · 部分可用：1/2 个实例", complete: false });
    expect(cells.memQuota).toMatchObject({ kind: "value", text: "不限 · 部分可用：1/2 个实例", complete: false });
    expect(cells.disk).toMatchObject({ kind: "value", text: "0 B · 部分可用：1/2 个实例", complete: false });
    expect(cells.bootTime).toMatchObject({ kind: "value", text: "2 分钟 · 部分可用：1/2 个实例", complete: false });
  });

  it("reports missing metrics without inventing resource zeros", () => {
    const view = build(
      dockerReading([row("rdc-13")]),
      qemuReading([row("qc-13")]),
    );
    // The rows have no inspect metrics, so the read is explicitly unavailable.
    for (const track of ["docker", "qemu"] as const) {
      expect(view.groups[0].sides[track].cells.disk).toMatchObject({
        kind: "unavailable",
        reason: "不可用（本次读取无指标）",
      });
    }
  });

  it("calls an all-unknown node status a missing reading, not 0 running", () => {
    const view = build(
      null,
      qemuReading([
        row("qc-1", { androidVersion: "13", status: "unknown", host: "node1" }),
        row("qc-2", { androidVersion: "13", status: "unknown", host: "node1" }),
      ]),
    );

    const side = view.groups[0].sides.qemu;
    expect(side.cells.instances).toEqual({ kind: "count", text: "2", share: 1, note: "" });
    expect(side.cells.running).toEqual({
      kind: "unavailable",
      reason: "不可用（节点未报告运行状态）",
      detail: "unknown",
    });
    expect(zeroFree(side.cells.running)).toBe(true);
  });

  it("notes a partially unknown status set instead of rounding it away", () => {
    const view = build(
      null,
      qemuReading([
        row("qc-1", { androidVersion: "13", host: "node1" }),
        row("qc-2", { androidVersion: "13", status: "unknown", host: "node1" }),
      ]),
    );

    expect(view.groups[0].sides.qemu.cells.running).toEqual({
      kind: "count",
      text: "1 / 2",
      share: 0.5,
      note: "1 个状态未知",
    });
  });

  it("keeps the health summary a badge-shaped statement (shared wording)", () => {
    const view = build(dockerReading([row("rdc-1")]), qemuReading([row("qc-1", { androidVersion: "13", host: "node1" })]));
    expect(view.groups[0].sides.docker.cells.health).toEqual({
      kind: "text",
      text: "正常",
      level: "ok",
      detail: "",
    });
    expect(view.groups[0].sides.qemu.cells.health).toMatchObject({ kind: "text", level: "ok" });
  });
});

describe("scope notes (what the snapshot does and does not cover)", () => {
  it("says the Docker count is redroid-only and names the total", () => {
    const view = build(dockerReading([row("rdc-1")], { containers: 5 }), null);
    expect(view.summaries.docker.scope).toBe(
      "仅统计 redroid 容器（本机 Docker 共 5 个容器，其中 1 个参与对比）",
    );
  });

  it("says the QEMU side only covers the selected node", () => {
    const view = build(null, qemuReading([row("qc-1", { androidVersion: "13", host: "node1" })]));
    expect(view.summaries.qemu.scope).toBe("QEMU 侧仅含当前所选节点 node1 的实例");
  });

  it("says instances were not read when no node is selected", () => {
    const view = build(null, qemuReading(null, { scope: "", instances: null }));
    expect(view.summaries.qemu.unavailable).toBe("未读取");
    expect(view.summaries.qemu.detail).toBe("QEMU 侧未选中节点，实例未读取");
  });
});
