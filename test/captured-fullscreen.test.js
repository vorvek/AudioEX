import assert from "node:assert/strict";
import test from "node:test";

import { CapturedFullscreenController } from "../lib/captured-fullscreen.js";

test("captured fullscreen restores after a background restart", async () => {
  const chrome = createFakeChrome({ 7: "normal" }, { 11: 7 });
  let controller = createController(chrome);

  await controller.enter(11);
  assert.equal(chrome.states.get(7), "fullscreen");

  controller = createController(chrome);
  await controller.leave(11);
  assert.equal(chrome.states.get(7), "normal");
  assert.deepEqual(chrome.updates, [
    [7, "fullscreen"],
    [7, "normal"]
  ]);
});

test("an existing browser fullscreen state remains user-owned", async () => {
  const chrome = createFakeChrome({ 7: "fullscreen" }, { 11: 7 });
  const controller = createController(chrome);

  await controller.enter(11);
  await controller.leave(11);

  assert.equal(chrome.states.get(7), "fullscreen");
  assert.deepEqual(chrome.updates, []);
});

test("a shared window restores after its final captured fullscreen tab exits", async () => {
  const chrome = createFakeChrome({ 7: "maximized" }, { 11: 7, 12: 7 });
  const controller = createController(chrome);

  await controller.enter(11);
  await controller.enter(12);
  await controller.leave(11);
  assert.equal(chrome.states.get(7), "fullscreen");

  await controller.leave(12);
  assert.equal(chrome.states.get(7), "maximized");
  assert.deepEqual(chrome.updates, [
    [7, "fullscreen"],
    [7, "maximized"]
  ]);
});

test("leaving does not overwrite a window state changed by the user", async () => {
  const chrome = createFakeChrome({ 7: "normal" }, { 11: 7 });
  const controller = createController(chrome);

  await controller.enter(11);
  chrome.states.set(7, "maximized");
  await controller.leave(11);

  assert.equal(chrome.states.get(7), "maximized");
  assert.deepEqual(chrome.updates, [[7, "fullscreen"]]);
});

function createFakeChrome(windowStates, tabWindows) {
  const states = new Map(Object.entries(windowStates).map(([id, state]) => [Number(id), state]));
  const updates = [];
  const storage = new Map();
  return {
    states,
    updates,
    storage,
    tabs: {
      async get(tabId) {
        return { id: tabId, windowId: tabWindows[tabId] };
      }
    },
    windows: {
      async get(windowId) {
        return { id: windowId, state: states.get(windowId) };
      },
      async update(windowId, update) {
        states.set(windowId, update.state);
        updates.push([windowId, update.state]);
        return { id: windowId, state: update.state };
      }
    },
    storageArea: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])
        );
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          storage.set(key, value);
        }
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          storage.delete(key);
        }
      }
    }
  };
}

function createController(chrome) {
  return new CapturedFullscreenController(chrome.tabs, chrome.windows, chrome.storageArea);
}
