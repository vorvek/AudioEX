import { createAudioGraph } from "./lib/audio-graph.js";
import { normalizeSettings } from "./lib/settings.js";

const sessions = new Map();
const starts = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: errorMessage(error), remaining: sessions.size })
    );
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "START_SESSION":
      return startSession(message.tabId, message.streamId, message.settings);
    case "STOP_SESSION":
      return stopSession(message.tabId);
    case "UPDATE_SESSION":
      return updateSession(message.tabId, message.settings);
    case "GET_SESSION":
      return getSession(message.tabId);
    case "SESSION_COUNT":
      return { ok: true, remaining: sessions.size };
    default:
      throw new Error("Unknown offscreen command.");
  }
}

async function startSession(tabId, streamId, settings) {
  requireTabId(tabId);
  if (typeof streamId !== "string" || streamId.length === 0) {
    throw new TypeError("A tab capture stream ID is required.");
  }

  if (sessions.has(tabId)) {
    const session = sessions.get(tabId);
    session.settings = session.graph.apply(settings);
    return sessionResponse(session);
  }

  if (starts.has(tabId)) {
    return starts.get(tabId);
  }

  const start = createSession(tabId, streamId, normalizeSettings(settings)).finally(() => {
    starts.delete(tabId);
  });
  starts.set(tabId, start);
  return start;
}

async function createSession(tabId, streamId, settings) {
  let stream;
  let context;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    context = new AudioContext({ latencyHint: "interactive" });
    const source = context.createMediaStreamSource(stream);
    const graph = createAudioGraph(context, source, settings);
    graph.output.connect(context.destination);

    const session = {
      tabId,
      stream,
      context,
      source,
      graph,
      settings: graph.settings,
      endedHandler: null
    };

    session.endedHandler = () => {
      void handleTrackEnded(session);
    };
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", session.endedHandler, { once: true });
    }

    await context.resume();
    if (stream.getTracks().every((track) => track.readyState === "ended")) {
      throw new Error("Tab audio capture ended before processing started.");
    }
    sessions.set(tabId, session);
    return sessionResponse(session);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") {
      await context.close();
    }
    throw error;
  }
}

async function stopSession(tabId) {
  requireTabId(tabId);
  if (starts.has(tabId)) {
    try {
      await starts.get(tabId);
    } catch {
      return { ok: true, active: false, stopped: false, remaining: sessions.size };
    }
  }

  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true, active: false, stopped: false, remaining: sessions.size };
  }

  sessions.delete(tabId);
  await destroySession(session);
  return { ok: true, active: false, stopped: true, remaining: sessions.size };
}

function updateSession(tabId, settings) {
  requireTabId(tabId);
  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true, active: false, settings: normalizeSettings(settings) };
  }

  session.settings = session.graph.apply(settings);
  return sessionResponse(session);
}

function getSession(tabId) {
  requireTabId(tabId);
  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true, active: false };
  }
  return sessionResponse(session);
}

async function handleTrackEnded(session) {
  if (sessions.get(session.tabId) !== session) {
    return;
  }

  sessions.delete(session.tabId);
  await destroySession(session);

  try {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "SESSION_ENDED",
      tabId: session.tabId,
      reason: "Tab audio capture ended"
    });
  } catch {
    // The service worker will reconcile state when the popup is opened again.
  }
}

async function destroySession(session) {
  for (const track of session.stream.getTracks()) {
    track.removeEventListener("ended", session.endedHandler);
    track.stop();
  }
  session.graph.output.disconnect();
  session.graph.dispose();
  if (session.context.state !== "closed") {
    await session.context.close();
  }
}

function sessionResponse(session) {
  return {
    ok: true,
    active: true,
    settings: normalizeSettings(session.settings),
    remaining: sessions.size
  };
}

function requireTabId(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("A valid tab ID is required.");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
