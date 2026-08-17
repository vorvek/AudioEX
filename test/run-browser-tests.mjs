import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(path.join(tmpdir(), "audioex-chrome-"));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(root, relative || "test/browser-audio.html");
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const body = await readFile(file);
    response.writeHead(200, { "content-type": contentType(file) });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/test/browser-audio.html`;

try {
  const result = await runChromeTests(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    url
  ], profile, url);

  if (result.status !== "passed") {
    throw new Error(result.text || "Browser audio tests failed.");
  }

  process.stdout.write("Browser DSP tests passed.\n");
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) {
    throw new Error("Chrome or Chromium was not found. Set CHROME_PATH and try again.");
  }
  return chrome;
}

async function runChromeTests(executable, args, userDataDirectory, pageUrl) {
  const child = spawn(executable, args, { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const port = await waitForDevToolsPort(userDataDirectory, child);
    const target = await waitForTarget(port, pageUrl, child);
    return await waitForPageResult(target.webSocketDebuggerUrl);
  } catch (error) {
    if (stderr) {
      process.stderr.write(stderr);
    }
    throw error;
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      delay(3000)
    ]);
  }
}

async function waitForDevToolsPort(userDataDirectory, child) {
  const portFile = path.join(userDataDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before tests started (${child.exitCode}).`);
    }

    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      if (Number.isInteger(Number(port))) {
        return Number(port);
      }
    } catch {
      // Chrome has not opened its debugging endpoint yet.
    }
    await delay(50);
  }
  throw new Error("Chrome did not open its debugging endpoint.");
}

async function waitForTarget(port, pageUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited during browser tests (${child.exitCode}).`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const pageTarget = targets.find(
        (candidate) => candidate.type === "page" && candidate.url === pageUrl
      );
      if (pageTarget?.webSocketDebuggerUrl) {
        return pageTarget;
      }
    } catch {
      // The target list may not be ready yet.
    }
    await delay(50);
  }
  throw new Error("Chrome did not open the browser test page.");
}

async function waitForPageResult(webSocketUrl) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await evaluatePageResult(webSocketUrl);
    } catch (error) {
      if (!error.message.includes("Execution context was destroyed")) {
        throw error;
      }
      await delay(50);
    }
  }
  throw new Error("Chrome repeatedly replaced the browser test page.");
}

function evaluatePageResult(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Browser audio tests timed out."));
    }, 20000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `new Promise((resolve) => {
              const check = () => {
                const status = document.body?.dataset.status;
                if (status === "passed" || status === "failed") {
                  resolve({ status, text: document.querySelector("#result")?.textContent });
                } else {
                  setTimeout(check, 25);
                }
              };
              check();
            })`,
            awaitPromise: true,
            returnByValue: true
          }
        })
      );
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }

      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        const detail =
          message.error?.message ||
          message.result?.exceptionDetails?.exception?.description ||
          message.result?.exceptionDetails?.text ||
          "Unknown evaluation error";
        reject(new Error(`Chrome could not evaluate the browser test result: ${detail}`));
        return;
      }
      resolve(message.result.result.value);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Chrome's debugging connection failed."));
    });
  });
}

function contentType(file) {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
