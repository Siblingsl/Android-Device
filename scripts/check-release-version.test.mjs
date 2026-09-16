import test from "node:test";
import assert from "node:assert/strict";

import { validateTag } from "./check-release-version.mjs";

const matchingVersions = {
  packageJson: "0.1.0",
  tauriConfig: "0.1.0",
  srcTauriCargo: "0.1.0",
  qemuCenterCargo: "0.1.0",
};

test("accepts a v-prefixed tag when every manifest has the same version", () => {
  assert.deepEqual(validateTag("v0.1.0", matchingVersions), { ok: true, errors: [] });
});

test("rejects a tag without the v prefix", () => {
  const result = validateTag("0.1.0", matchingVersions);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /v0\.1\.0/);
});

test("reports every manifest that disagrees with the tag", () => {
  const result = validateTag("v0.1.0", {
    ...matchingVersions,
    qemuCenterCargo: "0.2.0",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /qemuCenterCargo/);
  assert.match(result.errors.join("\n"), /0\.2\.0/);
});

test("rejects a missing manifest version instead of using a default", () => {
  const result = validateTag("v0.1.0", {
    ...matchingVersions,
    srcTauriCargo: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /srcTauriCargo/);
});
