import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest uses the minimal MV3 capture permissions", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual([...manifest.permissions].sort(), ["offscreen", "storage", "tabCapture"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test("every manifest entry point exists", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entries = [manifest.background.service_worker, manifest.action.default_popup];

  await Promise.all(entries.map((entry) => access(path.join(root, entry))));
});
