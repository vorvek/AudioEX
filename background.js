import { STORAGE_KEY, normalizeSettings } from "./lib/settings.js";
import { CapturedFullscreenController } from "./lib/captured-fullscreen.js";

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreenDocument = null;
let lifecycleTail = Promise.resolve();
const capturedFullscreen = new CapturedFullscreenController(
  chrome.tabs,
  chrome.windows,
  chrome.storage.session
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") {
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueueLifecycle(() => stopCapture(tabId, "Tab closed"));
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (!Number.isInteger(info.tabId)) {
    return;
  }

  void enqueueLifecycle(async () => {
    if (info.status === "stopped" || info.status === "error") {
      await reconcileCaptureStatus(info.tabId, info.status);
      return;
    }

    const activeFullscreen =
      info.fullscreen === true && (info.status === "active" || info.status === "pending");
    if (activeFullscreen) {
      await capturedFullscreen.enter(info.tabId);
    } else {
      await capturedFullscreen.leave(info.tabId);
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void enqueueLifecycle(() => capturedFullscreen.forgetWindow(windowId));
});

async function handleMessage(message) {
  switch (message.type) {
    case "GET_STATE":
      return getState(requireTabId(message.tabId));
    case "START_CAPTURE":
      return enqueueLifecycle(() =>
        startCapture(requireTabId(message.tabId), normalizeSettings(message.settings))
      );
    case "STOP_CAPTURE":
      return enqueueLifecycle(() => stopCapture(requireTabId(message.tabId), "Disabled"));
    case "UPDATE_SETTINGS":
      return updateSettings(requireTabId(message.tabId), normalizeSettings(message.settings));
    case "SESSION_ENDED":
      return enqueueLifecycle(() => sessionEnded(requireTabId(message.tabId), message.reason));
    default:
      throw new Error("Unknown AudioEX command.");
  }
}

async function getState(tabId) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  let settings = normalizeSettings(stored[STORAGE_KEY]);
  let active = false;

  if (await hasOffscreenDocument()) {
    try {
      const response = await sendToOffscreen({ type: "GET_SESSION", tabId });
      active = response?.active === true;
      if (active) {
        settings = normalizeSettings(response.settings);
      }
    } catch {
      active = false;
    }
  }

  await setBadge(tabId, active);
  return { ok: true, active, settings };
}

async function startCapture(tabId, settings) {
  try {
    await ensureOffscreenDocument();

    const existing = await sendToOffscreen({ type: "GET_SESSION", tabId });
    if (existing?.active) {
      await sendToOffscreen({ type: "UPDATE_SESSION", tabId, settings });
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
      await setBadge(tabId, true);
      return { ok: true, active: true, settings };
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const response = await sendToOffscreen({
      type: "START_SESSION",
      tabId,
      streamId,
      settings
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Chrome could not start tab audio capture.");
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    await setBadge(tabId, true);
    return { ok: true, active: true, settings: normalizeSettings(response.settings) };
  } catch (error) {
    await closeOffscreenIfNoSessions();
    throw error;
  }
}

async function stopCapture(tabId, reason) {
  await capturedFullscreen.leave(tabId);

  if (!(await hasOffscreenDocument())) {
    await setBadge(tabId, false);
    return { ok: true, active: false };
  }

  let response;
  try {
    response = await sendToOffscreen({ type: "STOP_SESSION", tabId });
    if (!response?.ok) {
      throw new Error(response?.error || "AudioEX could not stop this tab's capture.");
    }
  } catch (error) {
    await closeOffscreenIfNoSessions();
    throw error;
  }

  await setBadge(tabId, false);
  if (response.stopped === true) {
    await notifyPopup(tabId, reason);
  }
  await closeOffscreenIfIdle(response?.remaining);
  return { ok: true, active: false };
}

async function updateSettings(tabId, settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  let active = false;

  if (await hasOffscreenDocument()) {
    try {
      const response = await sendToOffscreen({ type: "UPDATE_SESSION", tabId, settings });
      active = response?.active === true;
    } catch {
      active = false;
    }
  }

  return { ok: true, active, settings };
}

async function sessionEnded(tabId, reason) {
  if (await hasOffscreenDocument()) {
    try {
      const current = await sendToOffscreen({ type: "GET_SESSION", tabId });
      if (current?.active) {
        await setBadge(tabId, true);
        return { ok: true, stale: true };
      }
    } catch {
      // Continue with cleanup if the document is no longer responsive.
    }
  }

  await capturedFullscreen.leave(tabId);
  await setBadge(tabId, false);
  await notifyPopup(tabId, reason || "Audio capture ended");

  if (await hasOffscreenDocument()) {
    try {
      const response = await sendToOffscreen({ type: "SESSION_COUNT" });
      await closeOffscreenIfIdle(response?.remaining);
    } catch {
      // The offscreen document may already be closing.
    }
  }

  return { ok: true };
}

async function reconcileCaptureStatus(tabId, status) {
  try {
    const captures = await chrome.tabCapture.getCapturedTabs();
    const replacement = captures.find(
      (capture) =>
        capture.tabId === tabId && (capture.status === "active" || capture.status === "pending")
    );
    if (replacement) {
      if (replacement.fullscreen) {
        await capturedFullscreen.enter(tabId);
      } else {
        await capturedFullscreen.leave(tabId);
      }
      return { ok: true, stale: true };
    }
  } catch {
    return { ok: true, deferred: true };
  }

  return stopCapture(tabId, `Capture ${status}`);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA"],
        justification: "Capture and process tab audio after the popup closes."
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  await creatingOffscreenDocument;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
}

async function closeOffscreenIfIdle(remaining) {
  if (remaining !== 0 || !(await hasOffscreenDocument())) {
    return;
  }

  await chrome.offscreen.closeDocument();
}

async function closeOffscreenIfNoSessions() {
  try {
    if (!(await hasOffscreenDocument())) {
      return;
    }
    const response = await sendToOffscreen({ type: "SESSION_COUNT" });
    await closeOffscreenIfIdle(response?.remaining);
  } catch {
    // Preserve the original capture error.
  }
}

async function setBadge(tabId, active) {
  try {
    await chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
    if (active) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#137333" });
    }
  } catch {
    // A closed tab no longer has a badge target.
  }
}

async function notifyPopup(tabId, reason) {
  try {
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "SESSION_ENDED",
      tabId,
      reason
    });
  } catch {
    // The popup is normally closed while capture is active.
  }
}

function enqueueLifecycle(operation) {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.catch(() => undefined);
  return result;
}

function requireTabId(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("A valid tab ID is required.");
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
