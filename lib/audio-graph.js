import { EQ_BANDS, MONO_MODES, normalizeSettings } from "./settings.js";

const DEFAULT_TRANSITION_SECONDS = 0.02;
const COMPRESSOR_LOOKAHEAD_SECONDS = 0.006;

export function compileDspSettings(settings, sampleRate) {
  const normalized = normalizeSettings(settings);
  const monoMatrix = getMonoMatrix(normalized.mono.enabled, normalized.mono.mode);
  const maximumFrequency = Number.isFinite(sampleRate) ? sampleRate * 0.45 : 21600;

  return {
    normalized,
    effectOrder: normalized.effectOrder,
    equalizer: EQ_BANDS.map((band, index) => ({
      frequency: Math.min(band.frequency, maximumFrequency),
      gain: normalized.equalizer.enabled ? normalized.equalizer.gains[index] : 0
    })),
    monoMatrix,
    amplifierGain: normalized.amplifier.enabled
      ? 10 ** (normalized.amplifier.gainDb / 20)
      : 1,
    compressor: {
      threshold: normalized.compressor.threshold,
      ratio: normalized.compressor.ratio,
      makeupGain: 10 ** (normalized.compressor.makeupGainDb / 20),
      dryGain: normalized.compressor.enabled ? 0 : 1,
      wetGain: normalized.compressor.enabled ? 1 : 0
    }
  };
}

export function getMonoMatrix(enabled, mode) {
  if (!enabled) {
    return Object.freeze({ leftLeft: 1, leftRight: 0, rightLeft: 0, rightRight: 1 });
  }

  if (mode === MONO_MODES.COPY_LEFT) {
    return Object.freeze({ leftLeft: 1, leftRight: 1, rightLeft: 0, rightRight: 0 });
  }

  if (mode === MONO_MODES.COPY_RIGHT) {
    return Object.freeze({ leftLeft: 0, leftRight: 0, rightLeft: 1, rightRight: 1 });
  }

  return Object.freeze({ leftLeft: 0.5, leftRight: 0.5, rightLeft: 0.5, rightRight: 0.5 });
}

export function createAudioGraph(context, source, initialSettings, options = {}) {
  if (!context || !source) {
    throw new TypeError("An AudioContext and source node are required.");
  }

  const transitionSeconds = Number.isFinite(options.transitionSeconds)
    ? Math.max(0, options.transitionSeconds)
    : DEFAULT_TRANSITION_SECONDS;

  const input = context.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";
  source.connect(input);

  const filters = EQ_BANDS.map(() => {
    const filter = context.createBiquadFilter();
    filter.type = "peaking";
    filter.Q.value = Math.SQRT2;
    return filter;
  });

  for (let index = 0; index < filters.length - 1; index += 1) {
    filters[index].connect(filters[index + 1]);
  }

  const splitter = context.createChannelSplitter(2);
  const merger = context.createChannelMerger(2);

  const leftLeft = context.createGain();
  const leftRight = context.createGain();
  const rightLeft = context.createGain();
  const rightRight = context.createGain();

  splitter.connect(leftLeft, 0);
  splitter.connect(leftRight, 0);
  splitter.connect(rightLeft, 1);
  splitter.connect(rightRight, 1);
  leftLeft.connect(merger, 0, 0);
  leftRight.connect(merger, 0, 1);
  rightLeft.connect(merger, 0, 0);
  rightRight.connect(merger, 0, 1);

  const amplifier = context.createGain();

  const compressorInput = context.createGain();
  const dryDelay = context.createDelay(0.02);
  dryDelay.delayTime.value = COMPRESSOR_LOOKAHEAD_SECONDS;
  const compressor = context.createDynamicsCompressor();
  compressor.knee.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;
  const makeupGain = context.createGain();
  const dryGain = context.createGain();
  const wetGain = context.createGain();
  const compressorOutput = context.createGain();
  const output = context.createGain();

  compressorInput.connect(dryDelay);
  compressorInput.connect(compressor);
  dryDelay.connect(dryGain);
  compressor.connect(makeupGain);
  makeupGain.connect(wetGain);
  dryGain.connect(compressorOutput);
  wetGain.connect(compressorOutput);

  const effectBlocks = Object.freeze({
    equalizer: Object.freeze({ input: filters[0], output: filters.at(-1) }),
    mono: Object.freeze({ input: splitter, output: merger }),
    amplifier: Object.freeze({ input: amplifier, output: amplifier }),
    compressor: Object.freeze({ input: compressorInput, output: compressorOutput })
  });

  const nodes = {
    input,
    filters,
    splitter,
    merger,
    leftLeft,
    leftRight,
    rightLeft,
    rightRight,
    amplifier,
    compressorInput,
    dryDelay,
    compressor,
    makeupGain,
    dryGain,
    wetGain,
    compressorOutput,
    output
  };

  let currentSettings = normalizeSettings(initialSettings);
  let currentOrder = [];
  let chainConnections = [];

  function apply(settings, smooth = true) {
    const compiled = compileDspSettings(settings, context.sampleRate);
    const now = context.currentTime;
    const duration = smooth ? transitionSeconds : 0;

    if (!sameOrder(currentOrder, compiled.effectOrder)) {
      connectEffectChain(compiled.effectOrder);
    }

    compiled.equalizer.forEach((band, index) => {
      setParam(filters[index].frequency, band.frequency, now, 0);
      setParam(filters[index].gain, band.gain, now, duration);
    });

    setParam(leftLeft.gain, compiled.monoMatrix.leftLeft, now, duration);
    setParam(leftRight.gain, compiled.monoMatrix.leftRight, now, duration);
    setParam(rightLeft.gain, compiled.monoMatrix.rightLeft, now, duration);
    setParam(rightRight.gain, compiled.monoMatrix.rightRight, now, duration);
    setParam(amplifier.gain, compiled.amplifierGain, now, duration);
    setParam(compressor.threshold, compiled.compressor.threshold, now, duration);
    setParam(compressor.ratio, compiled.compressor.ratio, now, duration);
    setParam(makeupGain.gain, compiled.compressor.makeupGain, now, duration);
    setParam(dryGain.gain, compiled.compressor.dryGain, now, duration);
    setParam(wetGain.gain, compiled.compressor.wetGain, now, duration);

    currentSettings = compiled.normalized;
    return currentSettings;
  }

  function connectEffectChain(order) {
    for (const connection of chainConnections) {
      try {
        connection.source.disconnect(connection.destination);
      } catch {
        connection.source.disconnect();
      }
    }

    chainConnections = [];
    let previous = input;
    for (const effectId of order) {
      const block = effectBlocks[effectId];
      previous.connect(block.input);
      chainConnections.push({ source: previous, destination: block.input });
      previous = block.output;
    }
    previous.connect(output);
    chainConnections.push({ source: previous, destination: output });
    currentOrder = [...order];
  }

  function dispose() {
    try {
      source.disconnect(input);
    } catch {
      source.disconnect();
    }

    for (const node of flattenNodes(nodes)) {
      node.disconnect();
    }
  }

  apply(currentSettings, false);

  return {
    output,
    nodes,
    effectBlocks,
    apply,
    dispose,
    get settings() {
      return normalizeSettings(currentSettings);
    }
  };
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setParam(param, value, now, duration) {
  if (duration <= 0) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(value, now);
    return;
  }

  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
    param.linearRampToValueAtTime(value, now + duration);
    return;
  }

  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + duration);
}

function flattenNodes(nodes) {
  return Object.values(nodes).flatMap((value) => (Array.isArray(value) ? value : [value]));
}
