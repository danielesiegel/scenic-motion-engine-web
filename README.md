# scenic-motion-engine-web

Audio-reactive looping marquee. The frame is filled with horizontal rows of
`scenicsynth` repeating with the shared trailing/leading `s` collapsed; one
or more 12-glyph `scenicsynths` spans are rendered in a brighter "key" color.
Alternate rows scroll opposite directions. All motion — row velocity, glyph
jitter, camera zoom/tilt/pan — is driven by per-band transient events from a
pre-analyzed audio track.

The engine is a **pure function of time**: `evaluate(t, config, source) → FrameState`.
No mutable accumulators. Scrubbing, looping and offline frame-by-frame export
are frame-identical to live playback.

**Status: this is the TypeScript/Canvas 2D prototype. A Rust/Metal native
Mac port is in progress at [`scenic-motion-engine-mac`](../scenic-motion-engine-mac/).
The web version is kept as a reference implementation; expect latency and
dropped frames on dense tracks in-browser.**

---

## Install

```
npm install
```

Drop a `.wav` into `assets/audio/` and a font (`ITC Avant Garde Gothic LT Demi`
or a URW Gothic / TeX Gyre Adventor fallback) into `assets/fonts/`. See
`src/text/font.ts` for the full candidate filename list.

## Analyze audio (one-time per track)

Produces `analysis/<track>.json` (consumed by the engine) and a diagnostic PNG.

```
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
npm run analyze -- --input assets/audio/<track>.wav
```

Flags: `--kick-lo/--kick-hi/...`, `--k-kick/--k-snare/...` (adaptive-threshold
sensitivity k), `--ref-kick/--ref-snare/...` (refractory ms), `--stems`
(demucs separation if installed). See `scripts/analyze.py --help`.

## Preview

```
npm run dev
```

Vite dev server at `http://127.0.0.1:5173/`. Live GUI (Tweakpane) folders:

- **feel** — preset (`default | snappy | smooth | punchy | glacial | bouncy | custom`),
  horizontal × scale, duration scale, global easing override, cubic-bezier
  override, row velocity curve (`flat | u | inverted-u | linear`) with edge
  multiplier.
- **layout** — font size, leading, rotation, row stagger, margin,
  `renderScale (live)` supersampling.
- **colors / spotlight / text** — self-explanatory.
- **spotlight** — `rows` (`all / even / odd / single`), `frequency` (every Nth
  unit gets a spotlight), `offsetUnits`, `rowPhaseOffset` (scatter per row),
  `mode: travels / anchored`.
- **band thresholds** — kick / snare / mid / hats runtime strength filter.
- **tickers** — per-ticker modulo, band, strength, `step` + `stepOffset` (fire
  every Nth event with offset — e.g. 4th / 8th / 12th kick).
- **bindings** — per-phase path + duration + easing.
- **camera baseline** — static zoom / pan / tilt + `rowOvershoot` (extra
  overflow rows so zoom/tilt doesn't expose canvas edges).
- **record** — start, duration, fps, bitrate, resolution ×, engine (`auto /
  webcodecs (mp4) / mediarecorder (webm)`), slowdown (fallback only).

Keyboard-less controls: play / still / HUD toggle / scrub bar below the stage.

## Record

Click **RECORD webm (in-browser)** in the `record` folder.

- With `engine: auto` and in Chrome/Arc you get a **frame-perfect MP4** via
  WebCodecs: the live loop is paused, the recorder drives
  `renderFrameAt(t)` synchronously for `fps × duration` frames, each wrapped
  as a `VideoFrame` with its own microsecond timestamp. Zero dropped frames.
  Video-only — the GUI auto-copies an ffmpeg command to mux the original audio.
- With `engine: mediarecorder` (fallback): captures `canvas.captureStream`
  with the audio stream mixed in. `renderSlowdown` runs audio+engine at `1/N`
  wall speed so the stream doesn't drop frames; produces slow-mo webm plus a
  copied ffmpeg command (`setpts=PTS/N`) to speed back to real time.

For a deterministic, server-side H.264 render independent of browser health,
use the Playwright exporter:

```
npm run render -- --track <name> --fps 60 --size 1920x1080 [--bars N] [--start 0 --end 10]
```

Steps frames one-by-one in a headless Chromium and pipes PNGs to `ffmpeg
image2pipe → libx264`. Needs the dev server running.

## Tests

```
npm test
```

16/16: event-count monotonicity, phase cycling with `step`/`offset`,
continuity across phase changes (frozen past contributions + active),
truncation (new event mid-way through old action), determinism (3 calls at
the same t produce structurally equal rows; evaluating at t=1.5 after walking
through t=0.1, 0.8 is equal to evaluating at t=1.5 directly), alternation
invariant (`dir = rowIndex % 2 === 0 ? +1 : -1`, modulated or not via
`respectAlternation`), U-curve row velocity scaling.

## Architecture

```
src/
├── types.ts                   # Config, Band, PathContext, PathOutput, FrameState, …
├── config/defaults.ts         # DEFAULT_CONFIG — tickers + bindings + camera + record defaults
├── audio/
│   └── eventSource.ts         # JsonEventSource + SyntheticEventSource; countBefore/lastBefore
├── text/
│   ├── font.ts                # opentype.js + FontFace registration (magic-byte sniffs for Vite SPA fallback)
│   └── layout.ts              # buildUnitLayout: pre-shapes 'scenicsynth' with inter-unit kerning → unitPos + stride
├── motion/
│   ├── paths.ts               # registerPath / getPath — slideStep, stutter, glyphJitter, cameraZoomDeltaFocused, …
│   ├── phase.ts               # 19 named easings + cubic-bezier via Newton-Raphson
│   ├── tickers.ts             # ticker evaluation snapshot (for HUD)
│   └── bindings.ts            # row selector resolution
├── engine.ts                  # evaluate(t) — frozen-contribution + active-contribution composition per row + camera
├── render/canvas.ts           # Canvas 2D renderer: outer camera transform, per-row dx/dy/scale/rotation/opacity, sub-pixel snap
├── preview/
│   ├── gui.ts                 # Tweakpane panel
│   ├── hud.ts                 # per-ticker debug readout
│   ├── player.ts              # audio playback / scrub / loop region
│   ├── recorder.ts            # MediaRecorder fallback
│   └── webcodecsRecorder.ts   # VideoEncoder + mp4-muxer frame-by-frame MP4
└── main.ts                    # wire everything together
scripts/
├── analyze.py                 # librosa + scipy spectral-flux onset detection, 4 bands, adaptive threshold, demucs optional, diagnostic PNG
├── requirements.txt
└── render.ts                  # Playwright + ffmpeg deterministic exporter
tests/
├── tickers.test.ts
├── continuity.test.ts
└── determinism.test.ts
```

Full motion extension guide: **MOTION.md**.

## Text pattern

Repeating unit: **`scenicsynth`** (11 glyphs). Consecutive copies share the
`s` → the infinite stream `...scenicsynthscenicsynthscenicsynth...` reads as
one unbroken word. The glyph index `g` in that stream maps to character
`unit[g % 11]`.

**Key** span: **`scenicsynths`** (12 glyphs). Starts at a unit boundary
(glyph index `k * 11`), ends at the first `s` of the next unit (glyph
`k*11 + 11`). Visually with brackets marking the key:

```
...scenicsynthscenicsynth[scenicsynths]cenicsynthscenicsynth...
```

With `key.rows: 'all'` and `key.frequency: 10`, every 10th unit becomes a
spotlight. `key.mode: 'travels'` ties highlights to glyph indices (they
scroll with the row); `key.mode: 'anchored'` fixes them to screen windows
(glyphs light up as they pass through).

## Why the Mac native port?

The browser pipeline — `canvas.fillText` → `canvas.captureStream` →
`MediaRecorder` or `canvas.captureStream` → `VideoEncoder` → `mp4-muxer` —
is **cross-platform** but each stage introduces latency, GPU/CPU hand-offs,
and audio-visual-sync hazards. For dense tracks with lots of per-glyph
motion, the live preview can't sustain 60 fps on even recent Macs, and the
WebCodecs recorder, while frame-perfect in theory, is bottlenecked by
texture upload latency.

The Rust/Metal port targets:

- **GPU text** via `cosmic-text` + custom `wgpu` glyph atlas (no CPU text
  rasterization per frame)
- **Direct audio I/O** via `cpal` + `symphonia` — no browser audio graph
- **Native MP4 export** via `openh264` + an in-process muxer, no process
  spawning, no PNG pipe
- **`egui`** for the GUI panel running on the same wgpu surface as the stage
- Same `evaluate(t)` engine semantics, same JSON analysis format from the
  Python analyzer

See `scenic-motion-engine-mac/` for progress.

## License

MIT (prototype — the licensed ITC font is NOT included).
