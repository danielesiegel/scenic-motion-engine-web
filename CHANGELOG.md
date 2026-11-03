# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Project context, feature matrix, and architecture live in the
[README](./README.md). Contribution flow is documented in
[CONTRIBUTING.md](./CONTRIBUTING.md).

---

## [Unreleased]

### Added

### Changed

### Fixed

---

## [0.1.0] - 2026-11-02

Initial public release of the TypeScript / Canvas 2D prototype and
reference implementation for the scenic-motion-engine family. A native
Rust / Metal port is in progress at
[`scenic-motion-engine-mac`](https://github.com/danielesiegel/scenic-motion-engine-mac)
and consumes the same `analysis/*.json` format unchanged.

### Added

- **Engine** (`src/engine.ts`): deterministic
  `evaluate(t, config, source) -> FrameState` — a pure function of time.
  All 16 path functions, 19 named easings + cubic bezier (Newton-Raphson),
  step / step_offset subsampling, horizontal scale, U-curve row velocity,
  frozen+active composition, per-row direction alternation. No mutable
  accumulators — scrub, loop, and offline export are frame-identical to
  live playback.
- **Preview** (`src/preview/`): Canvas 2D stage with a Tweakpane control
  panel one-to-one with the Rust port's egui panel. Feel presets,
  horizontal x scale, row velocity curve, duration scale, global easing,
  spotlight / tickers / bindings / camera / record folders. Scrub + loop
  controls in a bottom bar; per-ticker HUD overlay.
- **Record pipeline** (`src/render/record.ts`): WebCodecs + `mp4-muxer`
  H.264 export in Chrome / Arc, with a `canvas.captureStream` +
  MediaRecorder `.webm` fallback for other browsers.
- **Deterministic exporter** (`scripts/render.ts`): Playwright headless
  Chromium drives the engine frame-by-frame; frames are piped to
  `ffmpeg` libx264 for a bit-reproducible MP4.
- **Audio** (`src/audio/`): HTMLAudio / WebAudio playback with a
  `JsonEventSource` + `SyntheticEventSource` and binary-search event
  indexing shared with the Rust port.
- **Text** (`src/text/font.ts`): `opentype.js` glyph loading from
  `assets/fonts/`; unit pre-shaping and inter-unit stride measurement for
  the `scenicsynth` / `scenicsynths` row pattern.
- **Analyzer** (`scripts/analyze.py`): Python / librosa four-band
  transient detection (kick / snare / mid / hats) with adaptive
  thresholds, refractory windows, optional `demucs` stem separation, and
  a diagnostic PNG per track.
- **Config** (`src/config/`): default config with 6 tickers, 6 bindings,
  camera, feel, record defaults.
- **Types** (`src/types.ts`): the immutable contract shared with the Rust
  port's `src/types.rs`. Governs the contract-first swarm pattern
  documented in [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Docs**: [README.md](./README.md), [MOTION.md](./MOTION.md) (path
  extension guide), [CONTRIBUTING.md](./CONTRIBUTING.md),
  [SECURITY.md](./SECURITY.md).
- **Tests** (`tests/`): Vitest determinism, continuity, and ticker suites
  that double as the acceptance tests for the Rust port.
- **Tooling**: Vite 5 dev + build, TypeScript 5.6 strict mode, Vitest 2
  test runner, Playwright 1.47 for render automation.

### Changed

- _(nothing — initial release)_

### Fixed

- _(nothing — initial release)_

---

[Unreleased]: https://github.com/danielesiegel/scenic-motion-engine-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/danielesiegel/scenic-motion-engine-web/releases/tag/v0.1.0
