import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = (process.env.RDC_UPDATE_ENDPOINT || "").trim();
const publicKey = (process.env.RDC_UPDATE_PUBKEY || "").trim();

if (!endpoint || !publicKey) {
  console.error("RDC_UPDATE_ENDPOINT 和 RDC_UPDATE_PUBKEY 必须同时配置，拒绝生成未签名更新包。");
  process.exit(2);
}

let parsed;
try {
  parsed = new URL(endpoint);
} catch {
  console.error("RDC_UPDATE_ENDPOINT 不是有效 URL。");
  process.exit(2);
}

if (parsed.protocol !== "https:") {
  console.error("RDC_UPDATE_ENDPOINT 必须使用 HTTPS。");
  process.exit(2);
}

const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriDir = join(repoDir, "src-tauri");
const binariesDir = join(tauriDir, "binaries");
const targetArgIndex = process.argv.findIndex((value) => value === "--target");
const targetFromArgs = targetArgIndex >= 0 ? process.argv[targetArgIndex + 1] : undefined;
const targetFromEquals = process.argv.find((value) => value.startsWith("--target="))?.slice(9);

function rustHostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.split(/\r?\n/).find((line) => line.startsWith("host: "))?.slice(6).trim() || "";
}

const targetTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
  process.env.TAURI_TARGET_TRIPLE?.trim() ||
  targetFromArgs?.trim() ||
  targetFromEquals?.trim() ||
  rustHostTriple();

if (!targetTriple) {
  console.error("无法确定 Rust target triple，拒绝生成缺少 MCP 服务的发布包。");
  process.exit(2);
}

const binaryExtension = targetTriple.includes("windows") ? ".exe" : "";
const stagedBinary = join(binariesDir, `rdc-mcp-${targetTriple}${binaryExtension}`);
const cargoTargetArgs =
  targetFromArgs || targetFromEquals || process.env.TAURI_ENV_TARGET_TRIPLE || process.env.TAURI_TARGET_TRIPLE
    ? ["--target", targetTriple]
    : [];

mkdirSync(binariesDir, { recursive: true });

const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const cargoResult = spawnSync(
  cargo,
  ["build", "--manifest-path", join(tauriDir, "Cargo.toml"), "--release", "--bin", "rdc-mcp", ...cargoTargetArgs],
  { cwd: repoDir, env: process.env, stdio: "inherit" },
);

if (cargoResult.status !== 0) {
  console.error(`rdc-mcp 编译失败（target ${targetTriple}），拒绝生成不完整发布包。`);
  process.exit(cargoResult.status ?? 1);
}

const builtBinary = join(
  tauriDir,
  "target",
  cargoTargetArgs.length ? targetTriple : "",
  "release",
  `rdc-mcp${binaryExtension}`,
);

if (!existsSync(builtBinary)) {
  console.error(`找不到已编译的 MCP 服务：${builtBinary}`);
  process.exit(2);
}

copyFileSync(builtBinary, stagedBinary);

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const env = {
  ...process.env,
  VITE_RDC_UPDATE_CONFIGURED: "1",
  TAURI_CONFIG: JSON.stringify({
    plugins: {
      updater: {
        endpoints: [endpoint],
        pubkey: publicKey,
      },
    },
    bundle: {
      externalBin: ["binaries/rdc-mcp"],
    },
  }),
};

try {
  const result = spawnSync(command, ["tauri", "build", ...process.argv.slice(2)], { cwd: repoDir, env, stdio: "inherit" });
  const exitCode = result.status ?? 1;
  rmSync(stagedBinary, { force: true });
  process.exit(exitCode);
} finally {
  rmSync(stagedBinary, { force: true });
}
