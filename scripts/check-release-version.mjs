import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJsonVersion(filePath, label) {
  const value = JSON.parse(readFileSync(filePath, "utf8")).version;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} version is missing in ${filePath}`);
  }
  return value.trim();
}

function readCargoVersion(filePath, label) {
  const packageSection = readFileSync(filePath, "utf8").split(/^\[(?:dependencies|dev-dependencies|features|lib|bin)/m, 1)[0];
  const match = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match?.[1]?.trim()) {
    throw new Error(`${label} version is missing in ${filePath}`);
  }
  return match[1].trim();
}

/** Read the four release version sources without applying defaults. */
export function readVersions(repoRoot) {
  const root = resolve(repoRoot);
  return {
    packageJson: readJsonVersion(join(root, "package.json"), "package.json"),
    tauriConfig: readJsonVersion(join(root, "src-tauri", "tauri.conf.json"), "tauri.conf.json"),
    srcTauriCargo: readCargoVersion(join(root, "src-tauri", "Cargo.toml"), "src-tauri/Cargo.toml"),
    qemuCenterCargo: readCargoVersion(join(root, "qemu-center", "Cargo.toml"), "qemu-center/Cargo.toml"),
  };
}

/** Validate a v-prefixed SemVer tag against every release version source. */
export function validateTag(tag, versions) {
  const errors = [];
  const normalizedTag = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : "";

  if (!VERSION_PATTERN.test(normalizedTag)) {
    errors.push(`tag must be a v-prefixed SemVer such as v0.1.0; received ${String(tag)}`);
  }

  if (errors.length === 0) {
    for (const [source, value] of Object.entries(versions)) {
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${source} is empty; refusing to use a default version`);
      } else if (value.trim() !== normalizedTag) {
        errors.push(`${source}=${value.trim()} does not match tag=${normalizedTag}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function runCli() {
  const scriptPath = fileURLToPath(import.meta.url);
  const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
  if (invokedPath !== scriptPath) return;

  const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
  try {
    const result = validateTag(tag, readVersions(dirname(dirname(scriptPath))));
    if (!result.ok) {
      console.error(result.errors.map((error) => `release version check: ${error}`).join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(`release version check: ${tag} matches package.json, tauri.conf.json, src-tauri/Cargo.toml and qemu-center/Cargo.toml`);
  } catch (error) {
    console.error(`release version check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

runCli();
