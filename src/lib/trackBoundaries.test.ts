// Dependency-direction guard for the merged containers page.
//
// The merge (docs/superpowers/specs/2026-09-16-docker-qemu-page-merge.md,
// sections 3, 6.3 and 9) puts two tracks side by side WITHOUT merging their
// capabilities, so the boundaries between them are load-bearing:
//
//   1. the two track panels must never depend on each other;
//   2. they must not reach up into the containers shell;
//   3. only the shell may host both panels;
//   4. track-exclusive service calls must not cross the boundary;
//   5. the shell and the read-only compare view call no service at all.
//
// All five hold today, but nothing kept them that way - a later edit could
// couple the tracks and every other test would still pass. This file is that
// guard. It reads the sources as text (comments stripped) instead of importing
// them, so a prose mention can neither satisfy nor break an assertion.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCKER_PANEL = "src/pages/tracks/DockerTrackPanel.tsx";
const QEMU_PANEL = "src/pages/tracks/QemuTrackPanel.tsx";
const SHELL = "src/pages/containers/RuntimePage.tsx";
const COMPARE = "src/pages/containers/RuntimeCompare.tsx";

/** Strip block and line comments so only executable text is matched. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * Commands that belong to the local-Docker track only: container / image /
 * volume lifecycle plus the WSL kernel and binder management that exists only
 * on that side. Deliberately NOT listed: the shared asset helpers below, and
 * device-agnostic utilities that either panel may legitimately need.
 */
const DOCKER_TRACK_EXCLUSIVE = [
  "createInstance",
  "cancelCreateInstance",
  "getCreateStage",
  "checkInstanceName",
  "nextFreeAdbPort",
  "checkAdbPort",
  "removeContainer",
  "startContainer",
  "stopContainer",
  "restartContainer",
  "renameContainer",
  "cloneContainer",
  "inspectContainer",
  "exportContainerConfig",
  "getContainerLogs",
  "refreshDockerInfo",
  "removeImage",
  "pruneDanglingImages",
  "removeVolume",
  "switchWslKernel",
  "getWslKernelStatus",
  "verifyWslBinder",
];

/**
 * Allowed in both panels: local asset helpers (GApps / Magisk / spoof
 * profiles). They describe assets, not track operations, so the QEMU panel
 * legitimately reuses them for its own preset form.
 */
const ALLOWED_SHARED = ["getLocalGappsPath", "getMagiskAssets", "listSpoofProfiles"];

describe("track boundaries: dependency direction", () => {
  it("keeps the two track panels independent of each other", () => {
    expect(code(DOCKER_PANEL), "Docker panel must not reference the QEMU panel").not.toMatch(
      /QemuTrackPanel/,
    );
    expect(code(QEMU_PANEL), "QEMU panel must not reference the Docker panel").not.toMatch(
      /DockerTrackPanel/,
    );
  });

  it("keeps the panels out of the containers layer (one-way dependency)", () => {
    for (const panel of [DOCKER_PANEL, QEMU_PANEL]) {
      expect(code(panel), `${panel} must not import the containers shell`).not.toMatch(
        /pages\/containers\//,
      );
      expect(code(panel), `${panel} must not reference the shell or the compare view`).not.toMatch(
        /RuntimePage|RuntimeCompare/,
      );
    }
  });

  it("lets only the shell host both panels", () => {
    const shell = code(SHELL);
    expect(shell).toMatch(/DockerTrackPanel/);
    expect(shell).toMatch(/QemuTrackPanel/);
  });
});

describe("track boundaries: service call surface", () => {
  it("never lets the Docker panel reach the QEMU service", () => {
    expect(code(DOCKER_PANEL)).not.toMatch(/QemuService\./);
  });

  it("never lets the QEMU panel call Docker-track-exclusive commands", () => {
    const qemu = code(QEMU_PANEL);
    for (const method of DOCKER_TRACK_EXCLUSIVE) {
      expect(qemu, `.${method}( belongs to the Docker track`).not.toMatch(
        new RegExp(`\\.${method}\\s*\\(`),
      );
    }
  });

  it("keeps the shared allowlist disjoint from the exclusive list", () => {
    for (const shared of ALLOWED_SHARED) {
      expect(DOCKER_TRACK_EXCLUSIVE).not.toContain(shared);
    }
  });

  it("keeps the shell and the compare view free of service calls", () => {
    for (const path of [SHELL, COMPARE]) {
      const source = code(path);
      expect(source, path).not.toMatch(/DeviceService/);
      expect(source, path).not.toMatch(/QemuService/);
      expect(source, path).not.toMatch(/invoke\(/);
    }
  });
});