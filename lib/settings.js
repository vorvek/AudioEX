export const STORAGE_KEY = "audioexSettings";

export const EQ_BANDS = Object.freeze([
  Object.freeze({ frequency: 31.25, label: "31" }),
  Object.freeze({ frequency: 62.5, label: "62" }),
  Object.freeze({ frequency: 125, label: "125" }),
  Object.freeze({ frequency: 250, label: "250" }),
  Object.freeze({ frequency: 500, label: "500" }),
  Object.freeze({ frequency: 1000, label: "1k" }),
  Object.freeze({ frequency: 2000, label: "2k" }),
  Object.freeze({ frequency: 4000, label: "4k" }),
  Object.freeze({ frequency: 8000, label: "8k" }),
  Object.freeze({ frequency: 16000, label: "16k" })
]);

export const MONO_MODES = Object.freeze({
  COPY_LEFT: "copy-left",
  COPY_RIGHT: "copy-right",
  SUM: "sum"
});

export const EFFECT_IDS = Object.freeze([
  "equalizer",
  "compressor",
  "amplifier",
  "mono"
]);

export const DEFAULT_EFFECT_ORDER = Object.freeze([
  "equalizer",
  "mono",
  "amplifier",
  "compressor"
]);

const VALID_MONO_MODES = new Set(Object.values(MONO_MODES));
const VALID_EFFECT_IDS = new Set(EFFECT_IDS);

export const DEFAULT_SETTINGS = deepFreeze({
  version: 2,
  effectOrder: DEFAULT_EFFECT_ORDER,
  equalizer: {
    enabled: false,
    gains: EQ_BANDS.map(() => 0)
  },
  compressor: {
    enabled: false,
    threshold: -6,
    ratio: 12,
    makeupGainDb: 0
  },
  amplifier: {
    enabled: false,
    gainDb: 6
  },
  mono: {
    enabled: false,
    mode: MONO_MODES.SUM
  }
});

export function normalizeSettings(value) {
  const input = isObject(value) ? value : {};
  const equalizer = isObject(input.equalizer) ? input.equalizer : {};
  const compressor = isObject(input.compressor) ? input.compressor : {};
  const amplifier = isObject(input.amplifier) ? input.amplifier : {};
  const mono = isObject(input.mono) ? input.mono : {};

  return {
    version: 2,
    effectOrder: normalizeEffectOrder(input.effectOrder),
    equalizer: {
      enabled: booleanOr(equalizer.enabled, DEFAULT_SETTINGS.equalizer.enabled),
      gains: EQ_BANDS.map((_, index) =>
        finiteInRange(equalizer.gains?.[index], -12, 12, 0)
      )
    },
    compressor: {
      enabled: booleanOr(compressor.enabled, DEFAULT_SETTINGS.compressor.enabled),
      threshold: finiteInRange(
        compressor.threshold,
        -24,
        -1,
        DEFAULT_SETTINGS.compressor.threshold
      ),
      ratio: finiteInRange(
        compressor.ratio,
        2,
        20,
        DEFAULT_SETTINGS.compressor.ratio
      ),
      makeupGainDb: finiteInRange(
        compressor.makeupGainDb,
        0,
        24,
        DEFAULT_SETTINGS.compressor.makeupGainDb
      )
    },
    amplifier: {
      enabled: booleanOr(amplifier.enabled, DEFAULT_SETTINGS.amplifier.enabled),
      gainDb: finiteInRange(
        amplifier.gainDb,
        0,
        12,
        DEFAULT_SETTINGS.amplifier.gainDb
      )
    },
    mono: {
      enabled: booleanOr(mono.enabled, DEFAULT_SETTINGS.mono.enabled),
      mode: VALID_MONO_MODES.has(mono.mode) ? mono.mode : DEFAULT_SETTINGS.mono.mode
    }
  };
}

function normalizeEffectOrder(value) {
  if (
    !Array.isArray(value) ||
    value.length !== EFFECT_IDS.length ||
    new Set(value).size !== EFFECT_IDS.length ||
    value.some((id) => !VALID_EFFECT_IDS.has(id))
  ) {
    return [...DEFAULT_EFFECT_ORDER];
  }
  return [...value];
}

function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function finiteInRange(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
