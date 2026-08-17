import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(path.join(tmpdir(), "audioex-fullscreen-"));
const extensionRoot = path.join(profile, "extension");
await prepareTestExtension();
const server = createServer(async (_request, response) => {
  const body = await readFile(path.join(root, "test", "fullscreen-repro.html"));
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const pageUrl = `http://127.0.0.1:${address.port}/`;
const chrome = findChrome();
const child = spawn(
  chrome,
  [
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    pageUrl
  ],
  { windowsHide: false }
);
let completed = false;

try {
  const port = await waitForDevToolsPort(profile, child);
  const page = await waitForTarget(port, (target) => target.type === "page" && target.url === pageUrl);
  const pageState = await evaluate(
    page.webSocketDebuggerUrl,
    "({ url: location.href, readyState: document.readyState, html: document.documentElement?.outerHTML })"
  );
  if (pageState.url !== pageUrl) {
    await navigate(page.webSocketDebuggerUrl, pageUrl);
  }
  await activateTarget(port, page.id);
  focusBrowser(child.pid);
  process.stdout.write("Fixture loaded.\n");
  const normal = await readViewport(page.webSocketDebuggerUrl);
  const baseline = await measureFullscreen(page.webSocketDebuggerUrl);
  process.stdout.write(`Baseline measured: ${JSON.stringify(baseline)}\n`);
  await evaluate(page.webSocketDebuggerUrl, "void document.exitFullscreen()");
  await delay(1000);

  const extensionId = await waitForExtensionId(profile);
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await pressExtensionShortcut(page.webSocketDebuggerUrl);
  const popup = await waitForTarget(
    port,
    (target) => target.url === popupUrl
  );
  process.stdout.write("Extension context loaded.\n");

  const capture = await evaluate(
    popup.webSocketDebuggerUrl,
    `(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        throw new Error("Fullscreen fixture tab not found.");
      }
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "START_CAPTURE",
        tabId: tab.id,
        settings: {}
      });
      const captures = await chrome.tabCapture.getCapturedTabs();
      return { response, captures };
    })()`,
    { awaitPromise: true, userGesture: true }
  );
  process.stdout.write(`Capture started: ${JSON.stringify(capture)}\n`);
  if (!capture.response?.ok || !capture.captures.some((item) => item.status === "active")) {
    throw new Error(`AudioEX capture did not become active: ${JSON.stringify(capture)}`);
  }

  await fetch(`http://127.0.0.1:${port}/json/close/${popup.id}`);
  await activateTarget(port, page.id);
  focusBrowser(child.pid);
  const captured = await measureFullscreen(page.webSocketDebuggerUrl);
  await evaluate(page.webSocketDebuggerUrl, "void document.exitFullscreen()");
  await delay(1500);
  const restored = await readViewport(page.webSocketDebuggerUrl);
  process.stdout.write(`${JSON.stringify({ normal, baseline, captured, restored }, null, 2)}\n`);

  const baselineCoversScreen =
    baseline.fullscreen &&
    baseline.innerWidth === baseline.screenWidth &&
    baseline.innerHeight >= baseline.availHeight - 16;
  const capturedMatchesBaseline =
    captured.fullscreen &&
    captured.innerWidth === baseline.innerWidth &&
    Math.abs(captured.innerHeight - baseline.innerHeight) <= 2;
  const restoredWindow =
    !restored.fullscreen &&
    restored.outerWidth === normal.outerWidth &&
    restored.outerHeight === normal.outerHeight &&
    restored.innerWidth < baseline.innerWidth;

  if (!baselineCoversScreen) {
    throw new Error("The uncaptured baseline did not enter actual fullscreen.");
  }
  if (!capturedMatchesBaseline) {
    throw new Error("AudioEX capture prevented actual fullscreen.");
  }
  if (!restoredWindow) {
    throw new Error("AudioEX did not restore the browser window after fullscreen.");
  }
  process.stdout.write("AudioEX capture preserves actual fullscreen.\n");
  completed = true;
} finally {
  child.kill();
  server.close();
  await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(3000)]);
  if (completed) {
    await rm(profile, { recursive: true, force: true });
  } else {
    process.stderr.write(`Preserved failed browser profile: ${profile}\n`);
  }
}

async function measureFullscreen(webSocketUrl) {
  await evaluate(
    webSocketUrl,
    `new Promise((resolve) => {
      const check = () => document.querySelector("video") ? resolve() : setTimeout(check, 25);
      check();
    })`,
    { awaitPromise: true }
  );
  await evaluate(webSocketUrl, 'document.querySelector("video").requestFullscreen()', {
    awaitPromise: true,
    userGesture: true
  });
  await delay(1500);
  return readViewport(webSocketUrl);
}

function readViewport(webSocketUrl) {
  return evaluate(
    webSocketUrl,
    `({
      fullscreen: Boolean(document.fullscreenElement),
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight
    })`
  );
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    ...findPlaywrightChromiums(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error("Chrome was not found.");
  }
  return executable;
}

function findPlaywrightChromiums() {
  if (!process.env.LOCALAPPDATA) {
    return [];
  }

  const browsers = path.join(process.env.LOCALAPPDATA, "ms-playwright");
  try {
    return readdirSync(browsers, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((left, right) => Number(right.name.slice(9)) - Number(left.name.slice(9)))
      .map((entry) => path.join(browsers, entry.name, "chrome-win64", "chrome.exe"));
  } catch {
    return [];
  }
}

async function prepareTestExtension() {
  await mkdir(extensionRoot, { recursive: true });
  for (const file of [
    "background.js",
    "offscreen.html",
    "offscreen.js",
    "popup.css",
    "popup.html",
    "popup.js"
  ]) {
    await cp(path.join(root, file), path.join(extensionRoot, file));
  }
  await cp(path.join(root, "lib"), path.join(extensionRoot, "lib"), { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.commands = {
    _execute_action: {
      suggested_key: { default: "Ctrl+Shift+Y" }
    }
  };
  await writeFile(
    path.join(extensionRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

async function waitForDevToolsPort(userDataDirectory, process) {
  const portFile = path.join(userDataDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Chrome exited before tests started (${process.exitCode}).`);
    }
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      if (Number.isInteger(Number(port))) {
        return Number(port);
      }
    } catch {}
    await delay(50);
  }
  throw new Error("Chrome did not open its debugging endpoint.");
}

async function waitForExtensionId(userDataDirectory) {
  const preferenceFiles = ["Preferences", "Secure Preferences"].map((file) =>
    path.join(userDataDirectory, "Default", file)
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const preferencesFile of preferenceFiles) {
      try {
        const preferences = JSON.parse(await readFile(preferencesFile, "utf8"));
        const settings = preferences.extensions?.settings ?? {};
        const match = Object.entries(settings).find(([, extension]) =>
          path.resolve(extension.path ?? "") === extensionRoot
        );
        if (match) {
          return match[0];
        }
      } catch {}
    }
    await delay(50);
  }
  throw new Error("Chrome did not register the unpacked AudioEX extension.");
}

async function waitForTarget(port, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const target = targets.find(predicate);
    if (target?.webSocketDebuggerUrl) {
      return target;
    }
    await delay(50);
  }
  throw new Error("Chrome did not expose the requested debugging target.");
}

async function activateTarget(port, targetId) {
  const response = await fetch(`http://127.0.0.1:${port}/json/activate/${targetId}`);
  if (!response.ok) {
    throw new Error(`Chrome could not activate the fullscreen fixture (${response.status}).`);
  }
  await delay(250);
}

function focusBrowser(processId) {
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(New-Object -ComObject WScript.Shell).AppActivate(${processId}) | Out-Null`
    ],
    { windowsHide: true }
  );
}

async function pressExtensionShortcut(webSocketUrl) {
  await inputKey(webSocketUrl, "rawKeyDown");
  await inputKey(webSocketUrl, "keyUp");
  await delay(500);
}

function inputKey(webSocketUrl, type) {
  return sendCommand(webSocketUrl, "Input.dispatchKeyEvent", {
    type,
    modifiers: 10,
    key: "Y",
    code: "KeyY",
    windowsVirtualKeyCode: 89,
    nativeVirtualKeyCode: 89
  });
}

function sendCommand(webSocketUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Chrome ${method} command timed out.`));
    }, 20000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome's debugging connection failed."));
    });
  });
}

function evaluate(webSocketUrl, expression, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome evaluation timed out."));
    }, 20000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, ...params }
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      const detail = message.result?.exceptionDetails?.exception?.description;
      if (message.error || detail) {
        reject(new Error(detail || message.error.message));
      } else {
        resolve(message.result.result.value);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome's debugging connection failed."));
    });
  });
}

function navigate(webSocketUrl, url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome navigation timed out."));
    }, 20000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.errorText) {
        reject(new Error(message.error?.message || message.result.errorText));
      } else {
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome's debugging connection failed."));
    });
  });
}
