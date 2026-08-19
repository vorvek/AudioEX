import { EFFECT_IDS, EQ_BANDS, normalizeSettings } from "./lib/settings.js";

const elements = {
  status: document.querySelector("#status"),
  captureToggle: document.querySelector("#capture-toggle"),
  captureHint: document.querySelector("#capture-hint"),
  error: document.querySelector("#error"),
  effectChain: document.querySelector("#effect-chain"),
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
  compressorMakeupGain: document.querySelector("#compressor-makeup-gain"),
  compressorMakeupGainValue: document.querySelector("#compressor-makeup-gain-value"),
  amplifierSection: document.querySelector("#amplifier-section"),
  amplifierEnabled: document.querySelector("#amplifier-enabled"),
  amplifierGain: document.querySelector("#amplifier-gain"),
  amplifierGainValue: document.querySelector("#amplifier-gain-value"),
  monoSection: document.querySelector("#mono-section"),
  monoEnabled: document.querySelector("#mono-enabled"),
  monoMode: document.querySelector("#mono-mode")
};

const effectSections = Object.fromEntries(
  EFFECT_IDS.map((id) => [id, document.querySelector(`[data-effect-id="${id}"]`)])
);
const equalizerRows = [];
let tabId = null;
let settings = normalizeSettings();
let active = false;
let busy = false;
let updateTimer = null;
let updateTail = Promise.resolve();
let draggedSection = null;
let dragStartOrder = "";

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
  bindEffectReordering();

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

  bindRange(
    elements.compressorMakeupGain,
    (value) => {
      settings.compressor.makeupGainDb = value;
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

function bindEffectReordering() {
  for (const handle of elements.effectChain.querySelectorAll(".drag-handle")) {
    handle.addEventListener("dragstart", (event) => {
      draggedSection = handle.closest(".effect");
      dragStartOrder = readEffectOrder().join(",");
      draggedSection.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedSection.dataset.effectId);
    });
    handle.addEventListener("dragend", finishEffectDrag);
    handle.addEventListener("keydown", (event) => moveEffectWithKeyboard(event, handle));
  }

  elements.effectChain.addEventListener("dragover", (event) => {
    if (!draggedSection) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const nextSection = [...elements.effectChain.querySelectorAll(".effect")].find(
      (section) =>
        section !== draggedSection &&
        event.clientY < section.getBoundingClientRect().top + section.offsetHeight / 2
    );
    elements.effectChain.insertBefore(draggedSection, nextSection || null);
  });

  elements.effectChain.addEventListener("drop", (event) => {
    if (!draggedSection) {
      return;
    }
    event.preventDefault();
    finishEffectDrag();
  });
}

function finishEffectDrag() {
  if (!draggedSection) {
    return;
  }

  draggedSection.classList.remove("is-dragging");
  draggedSection = null;
  if (readEffectOrder().join(",") !== dragStartOrder) {
    commitEffectOrder();
  }
  dragStartOrder = "";
}

function moveEffectWithKeyboard(event, handle) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }

  const section = handle.closest(".effect");
  event.preventDefault();
  if (event.key === "ArrowUp" && section.previousElementSibling) {
    elements.effectChain.insertBefore(section, section.previousElementSibling);
  } else if (event.key === "ArrowDown" && section.nextElementSibling) {
    elements.effectChain.insertBefore(section.nextElementSibling, section);
  } else if (event.key === "Home") {
    elements.effectChain.prepend(section);
  } else if (event.key === "End") {
    elements.effectChain.append(section);
  }
  commitEffectOrder();
  handle.focus();
}

function commitEffectOrder() {
  const effectOrder = readEffectOrder();
  if (effectOrder.every((id, index) => id === settings.effectOrder[index])) {
    renderEffectOrder();
    return;
  }

  settings.effectOrder = effectOrder;
  renderEffectOrder();
  scheduleSettingsUpdate(true);
}

function readEffectOrder() {
  return [...elements.effectChain.querySelectorAll(".effect")].map(
    (section) => section.dataset.effectId
  );
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
    label.className = "equalizer-band";

    const name = document.createElement("span");
    name.className = "equalizer-frequency";
    name.textContent = band.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = "-12";
    input.max = "12";
    input.step = "0.5";
    input.setAttribute("aria-label", `${band.label} Hz equalizer gain`);

    const slider = document.createElement("span");
    slider.className = "equalizer-slider";
    slider.append(input);

    const output = document.createElement("output");
    output.className = "equalizer-gain";
    label.append(name, slider, output);
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
  renderEffectOrder();
  renderCaptureState();
  renderFeatures();
  renderEqualizer();
  renderCompressor();
  renderAmplifier();
  elements.monoMode.value = settings.mono.mode;
}

function renderEffectOrder() {
  settings.effectOrder.forEach((id) => elements.effectChain.append(effectSections[id]));
  settings.effectOrder.forEach((id, index) => {
    const handle = effectSections[id].querySelector(".drag-handle");
    handle.setAttribute(
      "aria-label",
      `Move ${effectLabel(id)}. Position ${index + 1} of ${EFFECT_IDS.length}`
    );
  });
}

function effectLabel(id) {
  return {
    equalizer: "equalizer",
    compressor: "compressor",
    amplifier: "amplifier",
    mono: "mono audio"
  }[id];
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
    [elements.compressorThreshold, elements.compressorRatio, elements.compressorMakeupGain]
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
  elements.compressorMakeupGain.value = String(settings.compressor.makeupGainDb);
  elements.compressorMakeupGainValue.textContent = formatDb(
    settings.compressor.makeupGainDb
  );
  elements.compressorMakeupGain.setAttribute(
    "aria-valuetext",
    formatDb(settings.compressor.makeupGainDb)
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
