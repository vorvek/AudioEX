import assert from "node:assert/strict";
import test from "node:test";

import {
  compileDspSettings,
  createAudioGraph,
  getMonoMatrix
} from "../lib/audio-graph.js";
import { EQ_BANDS, MONO_MODES, normalizeSettings } from "../lib/settings.js";

test("mono matrices implement all requested routing modes", () => {
  assert.deepEqual(getMonoMatrix(false, MONO_MODES.SUM), {
    leftLeft: 1,
    leftRight: 0,
    rightLeft: 0,
    rightRight: 1
  });
  assert.deepEqual(getMonoMatrix(true, MONO_MODES.COPY_LEFT), {
    leftLeft: 1,
    leftRight: 1,
    rightLeft: 0,
    rightRight: 0
  });
  assert.deepEqual(getMonoMatrix(true, MONO_MODES.COPY_RIGHT), {
    leftLeft: 0,
    leftRight: 0,
    rightLeft: 1,
    rightRight: 1
  });
  assert.deepEqual(getMonoMatrix(true, MONO_MODES.SUM), {
    leftLeft: 0.5,
    leftRight: 0.5,
    rightLeft: 0.5,
    rightRight: 0.5
  });
});

test("compiled settings bypass disabled processors and clamp high bands", () => {
  const settings = normalizeSettings();
  settings.equalizer.gains.fill(12);
  settings.amplifier.gainDb = 12;
  const compiled = compileDspSettings(settings, 32000);

  assert.ok(compiled.equalizer.every((band) => band.gain === 0));
  assert.equal(compiled.equalizer.at(-1).frequency, 14400);
  assert.equal(compiled.amplifierGain, 1);
  assert.equal(compiled.compressor.dryGain, 1);
  assert.equal(compiled.compressor.wetGain, 0);
});

test("compiled settings convert enabled boost from dB to linear gain", () => {
  const settings = normalizeSettings();
  settings.amplifier.enabled = true;
  settings.amplifier.gainDb = 6;
  settings.compressor.enabled = true;
  const compiled = compileDspSettings(settings, 48000);

  assert.ok(Math.abs(compiled.amplifierGain - 1.9952623149688795) < 1e-12);
  assert.equal(compiled.compressor.dryGain, 0);
  assert.equal(compiled.compressor.wetGain, 1);
});

test("graph creation wires ten EQ bands and starts fully bypassed", () => {
  const context = new FakeAudioContext();
  const source = new FakeNode("source");
  const graph = createAudioGraph(context, source, normalizeSettings());

  assert.equal(graph.nodes.filters.length, EQ_BANDS.length);
  assert.ok(graph.nodes.filters.every((filter) => filter.type === "peaking"));
  assert.ok(graph.nodes.filters.every((filter) => filter.gain.value === 0));
  assert.equal(graph.nodes.leftLeft.gain.value, 1);
  assert.equal(graph.nodes.leftRight.gain.value, 0);
  assert.equal(graph.nodes.rightLeft.gain.value, 0);
  assert.equal(graph.nodes.rightRight.gain.value, 1);
  assert.equal(graph.nodes.amplifier.gain.value, 1);
  assert.equal(graph.nodes.dryDelay.delayTime.value, 0.006);
  assert.equal(graph.nodes.dryGain.gain.value, 1);
  assert.equal(graph.nodes.wetGain.gain.value, 0);
  assert.equal(source.connections[0].destination, graph.nodes.input);
});

test("graph applies a complete settings snapshot", () => {
  const context = new FakeAudioContext();
  const source = new FakeNode("source");
  const graph = createAudioGraph(context, source, normalizeSettings());
  const settings = normalizeSettings({
    equalizer: { enabled: true, gains: EQ_BANDS.map((_, index) => index - 4.5) },
    compressor: { enabled: true, threshold: -9, ratio: 16 },
    amplifier: { enabled: true, gainDb: 9 },
    mono: { enabled: true, mode: MONO_MODES.COPY_RIGHT }
  });

  graph.apply(settings);

  assert.deepEqual(
    graph.nodes.filters.map((filter) => filter.gain.value),
    settings.equalizer.gains
  );
  assert.equal(graph.nodes.leftLeft.gain.value, 0);
  assert.equal(graph.nodes.leftRight.gain.value, 0);
  assert.equal(graph.nodes.rightLeft.gain.value, 1);
  assert.equal(graph.nodes.rightRight.gain.value, 1);
  assert.ok(Math.abs(graph.nodes.amplifier.gain.value - 2.8183829312644537) < 1e-12);
  assert.equal(graph.nodes.compressor.threshold.value, -9);
  assert.equal(graph.nodes.compressor.ratio.value, 16);
  assert.equal(graph.nodes.dryGain.gain.value, 0);
  assert.equal(graph.nodes.wetGain.gain.value, 1);
});

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
  }

  cancelScheduledValues() {}

  setValueAtTime(value) {
    this.value = value;
  }

  linearRampToValueAtTime(value) {
    this.value = value;
  }
}

class FakeNode {
  constructor(type) {
    this.type = type;
    this.connections = [];
    this.disconnected = false;
  }

  connect(destination, output = 0, input = 0) {
    this.connections.push({ destination, output, input });
    return destination;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super("gain");
    this.gain = new FakeAudioParam(1);
  }
}

class FakeFilter extends FakeNode {
  constructor() {
    super("filter");
    this.frequency = new FakeAudioParam(350);
    this.Q = new FakeAudioParam(1);
    this.gain = new FakeAudioParam(0);
  }
}

class FakeDelay extends FakeNode {
  constructor() {
    super("delay");
    this.delayTime = new FakeAudioParam(0);
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super("compressor");
    this.threshold = new FakeAudioParam(-24);
    this.knee = new FakeAudioParam(30);
    this.ratio = new FakeAudioParam(12);
    this.attack = new FakeAudioParam(0.003);
    this.release = new FakeAudioParam(0.25);
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
  }

  createGain() {
    return new FakeGain();
  }

  createBiquadFilter() {
    return new FakeFilter();
  }

  createChannelSplitter() {
    return new FakeNode("splitter");
  }

  createChannelMerger() {
    return new FakeNode("merger");
  }

  createDelay() {
    return new FakeDelay();
  }

  createDynamicsCompressor() {
    return new FakeCompressor();
  }
}
