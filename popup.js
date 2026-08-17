import { EQ_BANDS, normalizeSettings } from "./lib/settings.js";

const elements = {
  status: document.querySelector("#status"),
  captureToggle: document.querySelector("#capture-toggle"),
  captureHint: document.querySelector("#capture-hint"),
  error: document.querySelector("#error"),
  equalizerSection: document.querySelector("#equalizer-section"),
  equalizerEnabled: document.querySelector("#equalizer-enabled"),
  equalizerControls: document.querySelector("#equalizer-controls"),
  equalizerReset: document.querySelector("#equalizer-reset"),
  compressorSection: document.querySelector("#compressor-section"),
  compressorEnabled: document.querySelector("#compressor-enabled"),
  compressorThreshold: document.querySelector("#compressor-threshold"),
  compressorThresholdValue: document.querySelector("#compressor-threshold-value"),
  compressorRatio: document.querySelector("#compressor-ratio"),
  compressorRatioValue: document.querySelector("#compressor-ratio-value"),
  amplifierSection: document.querySelector("#amplifier-section"),
  amplifierEnabled: document.querySelector("#amplifier-enabled"),
  amplifierGain: document.querySelector("#amplifier-gain"),
  amplifierGainValue: document.querySelector("#amplifier-gain-value"),
  monoSection: document.querySelector("#mono-section"),
  monoEnabled: document.querySelector("#mono-enabled"),
  monoMode: document.querySelector("#mono-mode")
};

const equalizerRows = [];
let tabId = null;
let settings = normalizeSettings();
let active = false;
let busy = false;
let updateTimer = null;
let updateTail = Promise.resolve();

buildEqualizer();
bindEvents();
render();
void initialize();

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) {
      throw new Error("AudioEX could not identify this tab.");
    }

    tabId = tab.id;
    const response = await sendCommand("GET_STATE");
    active = response.active === true;
    settings = normalizeSettings(response.settings);
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    render();
  }
}

function bindEvents() {
  elements.captureToggle.addEventListener("click", () => {
    void toggleCapture();
  });

  elements.equalizerEnabled.addEventListener("change", () => {
    settings.equalizer.enabled = elements.equalizerEnabled.checked;
    renderFeatures();
    scheduleSettingsUpdate(true);
  });

  elements.equalizerReset.addEventListener("click", () => {
    settings.equalizer.gains.fill(0);
    renderEqualizer();
    scheduleSettingsUpdate(true);
  });

  elements.compressorEnabled.addEventListener("change", () => {
    settings.compressor.enabled = elements.compressorEnabled.checked;
    renderFeatures();
    scheduleSettingsUpdate(true);
  });

  bindRange(
    elements.compressorThreshold,
    (value) => {
      settings.compressor.threshold = value;
    },
    renderCompressor
  );

  bindRange(
    elements.compressorRatio,
    (value) => {
      settings.compressor.ratio = value;
    },
    renderCompressor
  );

  elements.amplifierEnabled.addEventListener("change", () => {
    settings.amplifier.enabled = elements.amplifierEnabled.checked;
    renderFeatures();
    scheduleSettingsUpdate(true);
  });

  bindRange(
    elements.amplifierGain,
    (value) => {
      settings.amplifier.gainDb = value;
    },
    renderAmplifier
  );

  elements.monoEnabled.addEventListener("change", () => {
    settings.mono.enabled = elements.monoEnabled.checked;
    renderFeatures();
    scheduleSettingsUpdate(true);
  });

  elements.monoMode.addEventListener("change", () => {
    settings.mono.mode = elements.monoMode.value;
    scheduleSettingsUpdate(true);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== "popup" || message.type !== "SESSION_ENDED") {
      return;
    }
    if (message.tabId === tabId) {
      active = false;
      busy = false;
      if (message.reason && message.reason !== "Disabled") {
        showError(message.reason);
      }
      renderCaptureState();
    }
  });
}

function bindRange(input, assign, renderValue) {
  input.addEventListener("input", () => {
    assign(Number(input.value));
    renderValue();
    scheduleSettingsUpdate(false);
  });
  input.addEventListener("change", () => {
    assign(Number(input.value));
    renderValue();
    scheduleSettingsUpdate(true);
  });
}

function buildEqualizer() {
  EQ_BANDS.forEach((band, index) => {
    const label = document.createElement("label");
    label.className = "control-row";

    const name = document.createElement("span");
    name.textContent = band.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = "-12";
    input.max = "12";
    input.step = "0.5";
    input.setAttribute("aria-label", `${band.label} Hz equalizer gain`);

    const output = document.createElement("output");
    label.append(name, input, output);
    elements.equalizerControls.append(label);
    equalizerRows.push({ input, output });

    bindRange(
      input,
      (value) => {
        settings.equalizer.gains[index] = value;
      },
      () => renderEqualizerRow(index)
    );
  });
}

async function toggleCapture() {
  if (busy || !Number.isInteger(tabId)) {
    return;
  }

  busy = true;
  clearError();
  renderCaptureState();
  renderFeatures();

  try {
    if (updateTimer !== null) {
      queueSettingsUpdate();
    }
    await updateTail.catch(() => undefined);
    const response = active
      ? await sendCommand("STOP_CAPTURE")
      : await sendCommand("START_CAPTURE", { settings });
    active = response.active === true;
    if (response.settings) {
      settings = normalizeSettings(response.settings);
    }
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    render();
  }
}

function scheduleSettingsUpdate(immediate) {
  clearTimeout(updateTimer);
  if (immediate) {
    queueSettingsUpdate();
    return;
  }

  updateTimer = setTimeout(queueSettingsUpdate, 70);
}

function queueSettingsUpdate() {
  clearTimeout(updateTimer);
  updateTimer = null;
  if (!Number.isInteger(tabId)) {
    return;
  }

  const snapshot = normalizeSettings(settings);
  updateTail = updateTail
    .catch(() => undefined)
    .then(() => sendCommand("UPDATE_SETTINGS", { settings: snapshot }))
    .then(clearError)
    .catch(showError);
}

async function sendCommand(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type,
    tabId,
    ...payload
  });
  if (!response?.ok) {
    throw new Error(response?.error || "AudioEX did not receive a response.");
  }
  return response;
}

function render() {
  settings = normalizeSettings(settings);
  renderCaptureState();
  renderFeatures();
  renderEqualizer();
  renderCompressor();
  renderAmplifier();
  elements.monoMode.value = settings.mono.mode;
}

function renderCaptureState() {
  elements.status.dataset.active = String(active);
  elements.status.textContent = active ? "On" : "Off";
  elements.captureToggle.dataset.active = String(active);
  elements.captureToggle.disabled = busy || !Number.isInteger(tabId);
  elements.captureToggle.textContent = busy
    ? active
      ? "Disabling…"
      : "Enabling…"
    : active
      ? "Disable on this tab"
      : "Enable on this tab";
  elements.captureHint.textContent = active
    ? "Processing continues after this popup closes."
    : "Settings are remembered for the next enabled tab.";
}

function renderFeatures() {
  elements.equalizerReset.disabled = busy;
  setFeatureState(
    elements.equalizerSection,
    elements.equalizerEnabled,
    settings.equalizer.enabled,
    equalizerRows.map((row) => row.input)
  );
  setFeatureState(
    elements.compressorSection,
    elements.compressorEnabled,
    settings.compressor.enabled,
    [elements.compressorThreshold, elements.compressorRatio]
  );
  setFeatureState(
    elements.amplifierSection,
    elements.amplifierEnabled,
    settings.amplifier.enabled,
    [elements.amplifierGain]
  );
  setFeatureState(elements.monoSection, elements.monoEnabled, settings.mono.enabled, [
    elements.monoMode
  ]);
}

function setFeatureState(section, checkbox, enabled, controls) {
  section.dataset.enabled = String(enabled);
  checkbox.checked = enabled;
  checkbox.disabled = busy;
  for (const control of controls) {
    control.disabled = busy || !enabled;
  }
}

function renderEqualizer() {
  equalizerRows.forEach((_, index) => renderEqualizerRow(index));
}

function renderEqualizerRow(index) {
  const gain = settings.equalizer.gains[index];
  equalizerRows[index].input.value = String(gain);
  equalizerRows[index].output.textContent = formatDb(gain);
  equalizerRows[index].input.setAttribute("aria-valuetext", formatDb(gain));
}

function renderCompressor() {
  elements.compressorThreshold.value = String(settings.compressor.threshold);
  elements.compressorThresholdValue.textContent = formatDb(settings.compressor.threshold);
  elements.compressorThreshold.setAttribute(
    "aria-valuetext",
    formatDb(settings.compressor.threshold)
  );
  elements.compressorRatio.value = String(settings.compressor.ratio);
  elements.compressorRatioValue.textContent = `${settings.compressor.ratio.toFixed(0)}:1`;
  elements.compressorRatio.setAttribute(
    "aria-valuetext",
    `${settings.compressor.ratio.toFixed(0)} to 1`
  );
}

function renderAmplifier() {
  elements.amplifierGain.value = String(settings.amplifier.gainDb);
  elements.amplifierGainValue.textContent = formatDb(settings.amplifier.gainDb);
  elements.amplifierGain.setAttribute("aria-valuetext", formatDb(settings.amplifier.gainDb));
}

function formatDb(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} dB`;
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}
