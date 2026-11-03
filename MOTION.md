# Motion Architecture

## Overview

Everything is a pure function:

```
evaluate(t, config, source, layout, rowCount, keyRow) -> FrameState
```

No mutable accumulators. No `requestAnimationFrame`-driven state. Given the
same inputs the engine returns the same `FrameState`, which means scrubbing
and offline rendering are frame-identical to live playback. Time is the only
driver.

## The chain

```
EventSource -> Tickers -> PhaseSequences -> Motion paths -> Bindings -> Renderer
```

- **EventSource** (`src/audio/eventSource.ts`): wraps the analysis JSON and
  answers `getEvents(band)`, `countBefore(band, t, threshold)`, and
  `eventAtIndex(band, i, threshold)`.
- **Tickers** (`src/motion/tickers.ts`): a ticker is `(band, modulo, offset,
  strengthThreshold)`. For time `t` it computes `count = events@<=t`,
  `phaseOfLatest = (count-1 + offset) mod modulo`, and `progress` within the
  active action.
- **PhaseSequences** (`src/types.ts`, `PhaseSequence`): an ordered list of
  `PhaseAction`s whose length equals `ticker.modulo`. Each action names a
  motion path, its params, duration, and easing.
- **Motion paths** (`src/motion/paths.ts`): a path is a pure function
  `(ctx: PathContext) => PathOutput`. Paths emit the delta they contribute
  right now at the given `progress`.
- **Bindings** (`src/motion/bindings.ts`): a binding attaches a sequence to
  a selected set of rows for a given ticker and compose mode.
- **Renderer** (`src/render/canvas.ts`): consumes `FrameState.rows[i]` and
  draws, treating `dx`, `dy`, `scale`, `rotation`, `opacity`, `tracking`, and
  any `perGlyph` outputs as straightforward transforms per row/glyph.

## Alternation invariant

Row direction is fixed by index:

```
dir(i) = i % 2 === 0 ? +1 : -1
```

Paths are written **direction-agnostic**: they emit positive values and
let the engine sign them. In `src/engine.ts` `applyDir()` multiplies the
path's `dx` and `perGlyph.dx` by `dir` before composing, unless the binding
sets `respectAlternation: false`.

This means authoring a path involves no branching on row parity: write a
rightward slide, and odd rows automatically slide left.

## Continuity model

The core property: output at time `t` is a pure function of past events, not
of integration history.

For a given ticker, let the filtered event times be `t[0] < t[1] < ... < t[K-1]`
with `t[K-1] <= t < t[K]` (K events have fired at or before t). Let
`duration_i` be the duration of the action triggered by event `i`.

The total output of the binding at time `t` is:

```
output(t) = Sum over i in [0, K-2] of  path_i(freezeProgress_i)
          + path_(K-1)(progress)
```

where

```
freezeProgress_i = clamp((t[i+1] - t[i]) / duration_i, 0, 1)   // frozen gap
progress         = clamp((t - t[K-1]) / duration_(K-1), 0, 1)  // active
```

Interpretation:

- Each past event is evaluated **once**, at the moment the next event fired
  (so it got cut short if events were tighter than `duration_i`).
- The latest event is evaluated at the actual elapsed time.
- Oscillation paths (`stutter`, `glyphJitter`, `scalePulse`, `trackingPulse`,
  `opacityDip`, `rotationFlicker`) all return 0 at `progress = 1`, so their
  frozen contributions vanish: they leave **no residue**.
- Slide-style paths (`slideStep`, `reverseNudge`, `driftSpeed`) return their
  full delta at `progress = 1`, so their frozen contributions **accumulate**.
  This is how continuous scroll emerges from discrete events.

Implementation lives in `evaluateBindingForRow()` in `src/engine.ts`.

## How to add a new motion path

Register the path in `src/motion/paths.ts`. The context passed in is:

| field          | meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `rowIndex`     | 0-based row                                             |
| `rowCount`     | total rows                                              |
| `dir`          | `+1` or `-1` (direction-agnostic authoring)             |
| `progress`     | 0..1 across the active action's `duration`              |
| `easedProgress`| `progress` after the action's easing                    |
| `strength`     | 0..1 — event strength that triggered this action        |
| `phase`        | current ticker phase                                    |
| `t`            | global time (seconds)                                   |
| `sinceLast`    | seconds since the triggering event                      |
| `params`       | binding params plus engine-injected keys                |

Return a `PathOutput` with any subset of `{ dx, dy, scale, rotation, opacity,
tracking, perGlyph }`.

```ts
registerPath('myWiggle', (ctx) => {
  const amp = Number(ctx.params.amplitude ?? 5)
  return { dy: Math.sin(ctx.easedProgress * Math.PI * 2) * amp * (1 - ctx.easedProgress) }
})
```

The envelope `(1 - ctx.easedProgress)` guarantees the path returns 0 at
`progress=1`, so it leaves no residue — standard shape for oscillators.

## How to rebind a ticker

Edit `src/config/defaults.ts` and add or modify an entry in `bindings`:

```ts
bindings: [
  { tickerId: 'kick-step', rows: 'keyRow', compose: 'add',
    sequence: { actions: [{ path: 'myWiggle', params: { amplitude: 8 }, duration: 0.3 }] } },
]
```

Rules:

- `sequence.actions.length` must equal the ticker's `modulo`.
- Each action's `path` must match a name registered in `src/motion/paths.ts`.
- `rows` accepts the selectors listed below.

## Compose modes

Set on the binding; default is `add`.

| mode       | dx/dy/rotation/tracking | scale (delta around 1) | opacity (delta around 1) |
| ---------- | ----------------------- | ----------------------- | ------------------------- |
| `add`      | sum                     | `state.scale *= (1 + d)`| `state.opacity += d` clamped |
| `multiply` | product                 | `state.scale *= (1 + d)`| `state.opacity *= (1 + d)`|
| `override` | replace                 | `state.scale = 1 + d`   | `state.opacity = 1 + d`   |

`scale` and `opacity` are stored as deltas composed around a baseline of 1.
A path emitting `scale: 0.03` means +3%, not `scale=0.03`.

## Params injected by the engine

At every path call the engine merges these into `params`:

| key         | value                                     |
| ----------- | ----------------------------------------- |
| `unitWidth` | `layout.stride` in pixels (unit span)     |
| `duration`  | the active action's `duration`            |
| `rowCount`  | total rows                                |
| `rowIndex`  | current row                               |

User params in the binding may override these if names collide, but **do not
rely on that** — treat these keys as reserved.

## Row selectors

```ts
'all'                               // every row
'even'                              // i % 2 === 0
'odd'                               // i % 2 === 1
'keyRow'                            // only the row that holds the key span
[2, 5, 7]                           // explicit indices
(i, n) => boolean                   // predicate
```

## A note on perGlyph outputs

A path can return

```ts
perGlyph: (glyphIndex) => ({ dx, dy, scale, rotation, opacity })
```

The engine stacks per-glyph functions and composes their outputs additively
per glyph in the renderer. Rules:

- Prefer **deterministic** functions. Hash `(glyphIndex, rowIndex,
  floor(t * 60))` so the result is stable across evaluations at the same
  frame but changes smoothly over time.
- `scale` and `opacity` from `perGlyph` are deltas (added to 1 at render).
- Horizontal components (`perGlyph.dx`) are also sign-flipped by `applyDir()`
  when `respectAlternation` is true.

## Why placeholder paths exist

These paths are shipped as plausible placeholders so bindings resolve and the
preview is non-trivial. **They are placeholders; replace them when motion
design is specified.**

| path             | one-liner                                                               |
| ---------------- | ----------------------------------------------------------------------- |
| `hold`           | no-op, used as a rest phase                                             |
| `slideStep`      | slide `units * unitWidth` pixels; settled delta persists                |
| `reverseNudge`   | slide back by a fraction of a unit; settled delta persists              |
| `stutter`        | damped horizontal oscillation that returns to 0 at `progress=1`         |
| `glyphJitter`    | per-glyph x/y jitter scaled by strength; no residue                     |
| `driftSpeed`     | integrated constant drift; residue = `pxPerSec * duration`              |
| `scalePulse`     | sine pulse on scale, baseline 1; no residue                             |
| `trackingPulse`  | sine pulse on letter spacing; no residue                                |
| `opacityDip`     | sine dip on row opacity; no residue                                     |
| `rotationFlicker`| damped rotation oscillation; no residue                                 |
