import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest uses the minimal MV3 capture permissions", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.1.1");
  assert.equal(packageJson.version, manifest.version);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual([...manifest.permissions].sort(), ["offscreen", "storage", "tabCapture"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test("every manifest entry point exists", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const expectedIcons = {
    "16": "icons/audioex-16.png",
    "32": "icons/audioex-32.png",
    "48": "icons/audioex-48.png",
    "128": "icons/audioex-128.png",
  };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);

  const entries = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);

  await Promise.all([...entries].map((entry) => access(path.join(root, entry))));
});
