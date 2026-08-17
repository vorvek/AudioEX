import { createAudioGraph } from "../lib/audio-graph.js";
import { MONO_MODES, normalizeSettings } from "../lib/settings.js";

const SAMPLE_RATE = 48000;
const DELAY_SAMPLES = Math.round(SAMPLE_RATE * 0.006);

try {
  await testStereoBypass();
  await testMonoModes();
  await testAmplifier();
  await testEqualizer();
  await testCompressor();
  document.body.dataset.status = "passed";
  document.querySelector("#result").textContent = "AUDIOEX_BROWSER_TESTS_PASSED";
} catch (error) {
  document.body.dataset.status = "failed";
  document.querySelector("#result").textContent = `AUDIOEX_BROWSER_TESTS_FAILED: ${error.stack}`;
}

async function testStereoBypass() {
  const rendered = await renderImpulse(1, 0.25, normalizeSettings());
  closeTo(rendered.getChannelData(0)[DELAY_SAMPLES], 1, 0.0001, "left bypass");
  closeTo(rendered.getChannelData(1)[DELAY_SAMPLES], 0.25, 0.0001, "right bypass");
}

async function testMonoModes() {
  const copyLeft = normalizeSettings({
    mono: { enabled: true, mode: MONO_MODES.COPY_LEFT }
  });
  let rendered = await renderImpulse(0.8, 0.2, copyLeft);
  closeTo(rendered.getChannelData(0)[DELAY_SAMPLES], 0.8, 0.0001, "copy left L");
  closeTo(rendered.getChannelData(1)[DELAY_SAMPLES], 0.8, 0.0001, "copy left R");

  const copyRight = normalizeSettings({
    mono: { enabled: true, mode: MONO_MODES.COPY_RIGHT }
  });
  rendered = await renderImpulse(0.8, 0.2, copyRight);
  closeTo(rendered.getChannelData(0)[DELAY_SAMPLES], 0.2, 0.0001, "copy right L");
  closeTo(rendered.getChannelData(1)[DELAY_SAMPLES], 0.2, 0.0001, "copy right R");

  const sum = normalizeSettings({ mono: { enabled: true, mode: MONO_MODES.SUM } });
  rendered = await renderImpulse(0.8, 0.2, sum);
  closeTo(rendered.getChannelData(0)[DELAY_SAMPLES], 0.5, 0.0001, "sum L");
  closeTo(rendered.getChannelData(1)[DELAY_SAMPLES], 0.5, 0.0001, "sum R");
}

async function testAmplifier() {
  const settings = normalizeSettings({ amplifier: { enabled: true, gainDb: 6 } });
  const rendered = await renderImpulse(0.25, 0.25, settings);
  const expected = 0.25 * 10 ** (6 / 20);
  closeTo(rendered.getChannelData(0)[DELAY_SAMPLES], expected, 0.0001, "amplifier");
}

async function testEqualizer() {
  const bypass = normalizeSettings();
  const boosted = normalizeSettings({
    equalizer: {
      enabled: true,
      gains: [0, 0, 0, 0, 0, 12, 0, 0, 0, 0]
    }
  });
  const bypassed = await renderTone(0.1, 1000, bypass);
  const equalized = await renderTone(0.1, 1000, boosted);
  const start = Math.round(SAMPLE_RATE * 0.15);
  const bypassRms = rms(bypassed.getChannelData(0), start);
  const equalizedRms = rms(equalized.getChannelData(0), start);
  const ratio = equalizedRms / bypassRms;

  if (ratio < 3.7 || ratio > 4.2) {
    throw new Error(`equalizer: expected a 12 dB ratio near 3.98, received ${ratio}`);
  }
}

async function testCompressor() {
  const bypass = normalizeSettings();
  const limited = normalizeSettings({
    compressor: { enabled: true, threshold: -12, ratio: 20 }
  });
  const bypassed = await renderConstant(0.8, bypass);
  const compressed = await renderConstant(0.8, limited);
  const start = Math.round(SAMPLE_RATE * 0.3);
  const bypassRms = rms(bypassed.getChannelData(0), start);
  const compressedRms = rms(compressed.getChannelData(0), start);

  if (!(compressedRms < bypassRms * 0.9)) {
    throw new Error(`compressor: expected ${compressedRms} below ${bypassRms * 0.9}`);
  }
}

async function renderImpulse(left, right, settings) {
  return render(settings, 4096, (buffer) => {
    buffer.getChannelData(0)[0] = left;
    buffer.getChannelData(1)[0] = right;
  });
}

async function renderConstant(amplitude, settings) {
  return render(settings, Math.round(SAMPLE_RATE * 0.5), (buffer) => {
    buffer.getChannelData(0).fill(amplitude);
    buffer.getChannelData(1).fill(amplitude);
  });
}

async function renderTone(amplitude, frequency, settings) {
  return render(settings, Math.round(SAMPLE_RATE * 0.35), (buffer) => {
    for (let index = 0; index < buffer.length; index += 1) {
      const sample = amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
      buffer.getChannelData(0)[index] = sample;
      buffer.getChannelData(1)[index] = sample;
    }
  });
}

async function render(settings, length, fill) {
  const context = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const buffer = context.createBuffer(2, length, SAMPLE_RATE);
  fill(buffer);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const graph = createAudioGraph(context, source, settings, { transitionSeconds: 0 });
  graph.output.connect(context.destination);
  source.start();
  return context.startRendering();
}

function rms(samples, start) {
  let sum = 0;
  for (let index = start; index < samples.length; index += 1) {
    sum += samples[index] ** 2;
  }
  return Math.sqrt(sum / (samples.length - start));
}

function closeTo(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}
