import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SETTINGS,
  EQ_BANDS,
  MONO_MODES,
  normalizeSettings
} from "../lib/settings.js";

test("default settings leave every processor bypassed", () => {
  const settings = normalizeSettings();

  assert.equal(settings.version, 1);
  assert.equal(settings.equalizer.enabled, false);
  assert.deepEqual(settings.equalizer.gains, EQ_BANDS.map(() => 0));
  assert.equal(settings.compressor.enabled, false);
  assert.equal(settings.amplifier.enabled, false);
  assert.equal(settings.mono.enabled, false);
});

test("equalizer exposes the exact ten-band contract", () => {
  assert.deepEqual(
    EQ_BANDS.map((band) => band.frequency),
    [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  );
});

test("normalization clamps every numeric setting", () => {
  const settings = normalizeSettings({
    equalizer: {
      enabled: true,
      gains: [-99, 99, "2.5", Number.NaN]
    },
    compressor: {
      enabled: true,
      threshold: -99,
      ratio: 100
    },
    amplifier: {
      enabled: true,
      gainDb: 30
    },
    mono: {
      enabled: true,
      mode: "invalid"
    }
  });

  assert.deepEqual(settings.equalizer.gains.slice(0, 4), [-12, 12, 2.5, 0]);
  assert.equal(settings.compressor.threshold, -24);
  assert.equal(settings.compressor.ratio, 20);
  assert.equal(settings.amplifier.gainDb, 12);
  assert.equal(settings.mono.mode, MONO_MODES.SUM);
});

test("normalization returns independent mutable snapshots", () => {
  const first = normalizeSettings(DEFAULT_SETTINGS);
  const second = normalizeSettings(first);

  second.equalizer.gains[0] = 8;
  second.mono.mode = MONO_MODES.COPY_LEFT;

  assert.equal(first.equalizer.gains[0], 0);
  assert.equal(first.mono.mode, MONO_MODES.SUM);
  assert.equal(DEFAULT_SETTINGS.equalizer.gains[0], 0);
});

test("non-boolean flags fall back instead of becoming truthy", () => {
  const settings = normalizeSettings({
    equalizer: { enabled: "true" },
    compressor: { enabled: 1 },
    amplifier: { enabled: null },
    mono: { enabled: {} }
  });

  assert.equal(settings.equalizer.enabled, false);
  assert.equal(settings.compressor.enabled, false);
  assert.equal(settings.amplifier.enabled, false);
  assert.equal(settings.mono.enabled, false);
});
