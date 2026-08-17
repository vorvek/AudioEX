const RESTORABLE_STATES = new Set(["normal", "maximized"]);
const KEY_PREFIX = "audioexCapturedFullscreen";

export class CapturedFullscreenController {
  constructor(tabsApi, windowsApi, storageArea) {
    this.tabsApi = tabsApi;
    this.windowsApi = windowsApi;
    this.storageArea = storageArea;
  }

  async enter(tabId) {
    const tabKey = keyForTab(tabId);
    if ((await this.storageArea.get(tabKey))[tabKey]) {
      return;
    }

    let tab;
    try {
      tab = await this.tabsApi.get(tabId);
    } catch {
      return;
    }

    const windowKey = keyForWindow(tab.windowId);
    const stored = await this.storageArea.get(windowKey);
    const existing = stored[windowKey];
    if (existing) {
      const tabs = [...new Set([...existing.tabs, tabId])];
      await this.storageArea.set({
        [windowKey]: { ...existing, tabs },
        [tabKey]: { windowId: tab.windowId }
      });
      return;
    }

    let browserWindow;
    try {
      browserWindow = await this.windowsApi.get(tab.windowId);
    } catch {
      return;
    }

    const session = {
      restoreState: RESTORABLE_STATES.has(browserWindow.state) ? browserWindow.state : null,
      tabs: [tabId]
    };
    await this.storageArea.set({
      [windowKey]: session,
      [tabKey]: { windowId: tab.windowId }
    });

    if (!session.restoreState) {
      return;
    }

    try {
      await this.windowsApi.update(tab.windowId, { state: "fullscreen" });
    } catch {
      await this.storageArea.remove([windowKey, tabKey]);
    }
  }

  async leave(tabId) {
    const tabKey = keyForTab(tabId);
    const tabRecord = (await this.storageArea.get(tabKey))[tabKey];
    if (!tabRecord) {
      return;
    }

    const windowKey = keyForWindow(tabRecord.windowId);
    const session = (await this.storageArea.get(windowKey))[windowKey];
    if (!session) {
      await this.storageArea.remove(tabKey);
      return;
    }

    const tabs = session.tabs.filter((candidate) => candidate !== tabId);
    if (tabs.length > 0) {
      await this.storageArea.set({ [windowKey]: { ...session, tabs } });
      await this.storageArea.remove(tabKey);
      return;
    }

    if (session.restoreState) {
      try {
        const browserWindow = await this.windowsApi.get(tabRecord.windowId);
        if (browserWindow.state === "fullscreen") {
          await this.windowsApi.update(tabRecord.windowId, { state: session.restoreState });
        }
      } catch {
        // The browser window may already be closed.
      }
    }
    await this.storageArea.remove([windowKey, tabKey]);
  }

  async forgetWindow(windowId) {
    const windowKey = keyForWindow(windowId);
    const session = (await this.storageArea.get(windowKey))[windowKey];
    const keys = [windowKey, ...(session?.tabs ?? []).map(keyForTab)];
    await this.storageArea.remove(keys);
  }
}

function keyForTab(tabId) {
  return `${KEY_PREFIX}:tab:${tabId}`;
}

function keyForWindow(windowId) {
  return `${KEY_PREFIX}:window:${windowId}`;
}
