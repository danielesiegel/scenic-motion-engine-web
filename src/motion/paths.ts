import type { PathContext, PathFn, PathOutput } from '../types'

// Deterministic small hash in [0,1) for jitter patterns.
function hash01(seed: number): number {
  // xmur3-ish, scalar version.
  let h = Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) % 1_000_003) / 1_000_003
}

// A path's output represents the delta it contributes *right now* at the given progress.
// At progress=1 the output is the "settled" delta that will persist until a new event fires.
// Oscillation paths should return to 0 by progress=1 so they leave no residue.

export const PATHS: Record<string, PathFn> = {}

export function registerPath(name: string, fn: PathFn): void {
  PATHS[name] = fn
}
export function getPath(name: string): PathFn | null {
  return PATHS[name] ?? null
}
export function listPaths(): string[] {
  return Object.keys(PATHS).sort()
}

// ---------------------------------------------------------------------------
// PLACEHOLDER PATHS — swap these when motion design is specified.
// ---------------------------------------------------------------------------

// Do nothing. Useful as a 'rest' phase.
registerPath('hold', (_ctx: PathContext): PathOutput => ({}))

// Slide the row by `units` unit-widths (dir-signed). Settled delta = units * UNIT_WIDTH_PLACEHOLDER.
// NOTE: paths don't know unit width here. They emit a value in units of unitWidth via the magic
// `_scaleByUnitWidth` convention is nope — simpler: paths emit real pixel values. Row width is injected
// via `ctx.params.unitWidth` by the engine at bind time.
registerPath('slideStep', (ctx: PathContext): PathOutput => {
  const units = Number(ctx.params.units ?? 1)
  const unitWidth = Number(ctx.params.unitWidth ?? 0)
  const target = units * unitWidth
  return { dx: target * ctx.easedProgress }
})

// Slide back by half-ish, then settle (settled delta is non-zero and persists).
registerPath('reverseNudge', (ctx: PathContext): PathOutput => {
  const units = Number(ctx.params.units ?? 0.5)
  const unitWidth = Number(ctx.params.unitWidth ?? 0)
  const target = -units * unitWidth
  return { dx: target * ctx.easedProgress }
})

// Oscillating stutter that returns to 0 at progress=1 (so no residue).
registerPath('stutter', (ctx: PathContext): PathOutput => {
  const count = Math.max(1, Math.floor(Number(ctx.params.count ?? 4)))
  const amplitude = Number(ctx.params.amplitude ?? 6)
  // Square-ish wave that collapses to 0 as progress -> 1.
  const envelope = 1 - ctx.easedProgress
  const phase = ctx.easedProgress * count * 2 * Math.PI
  return { dx: Math.sin(phase) * amplitude * envelope }
})

// Per-glyph vertical jitter, scales with event strength. No residue.
registerPath('glyphJitter', (ctx: PathContext): PathOutput => {
  const amplitude = Number(ctx.params.amplitude ?? 2) * ctx.strength
  const envelope = 1 - ctx.easedProgress
  const row = ctx.rowIndex
  return {
    perGlyph: (glyphIndex: number) => {
      const n = hash01(glyphIndex * 1013 + row * 7919 + Math.floor(ctx.t * 60))
      const m = hash01(glyphIndex * 7919 + row * 1013 + Math.floor(ctx.t * 60) + 1)
      return {
        dx: (n - 0.5) * 2 * amplitude * envelope,
        dy: (m - 0.5) * 2 * amplitude * envelope,
      }
    },
  }
})

// Constant drift speed, integrated across the active window. At progress=1 the row has moved
// by pxPerSec * duration — this residue persists until the next phase of this ticker.
registerPath('driftSpeed', (ctx: PathContext): PathOutput => {
  const pxPerSec = Number(ctx.params.pxPerSec ?? 0)
  const duration = Math.max(1e-6, Number(ctx.params.duration ?? 1))
  return { dx: pxPerSec * duration * ctx.easedProgress }
})

// A gentle scale pulse that returns to 1. No residue.
registerPath('scalePulse', (ctx: PathContext): PathOutput => {
  const magnitude = Number(ctx.params.magnitude ?? 0.03) * ctx.strength
  const envelope = Math.sin(ctx.easedProgress * Math.PI) // 0 -> 1 -> 0
  // scale is stored as a delta around 1 and composed additively, see engine.ts.
  return { scale: magnitude * envelope }
})

// Letter-spacing (tracking) pulse. No residue.
registerPath('trackingPulse', (ctx: PathContext): PathOutput => {
  const magnitude = Number(ctx.params.magnitude ?? 4) * ctx.strength
  const envelope = Math.sin(ctx.easedProgress * Math.PI)
  return { tracking: magnitude * envelope }
})

// Full-row opacity dip. Settles back to 0 delta (opacity 1 base).
registerPath('opacityDip', (ctx: PathContext): PathOutput => {
  const depth = Number(ctx.params.depth ?? 0.3) * ctx.strength
  const envelope = Math.sin(ctx.easedProgress * Math.PI)
  return { opacity: -depth * envelope }
})

// Rotation flicker. No residue.
registerPath('rotationFlicker', (ctx: PathContext): PathOutput => {
  const magnitude = Number(ctx.params.magnitude ?? 2) * ctx.strength
  const envelope = 1 - ctx.easedProgress
  const phase = ctx.easedProgress * Math.PI * 6
  return { rotation: Math.sin(phase) * magnitude * envelope }
})

// ---------------------------------------------------------------------------
// CAMERA PATHS — intended for bindings with target: 'camera'.
// scale → zoom delta (added to baseline 1), rotation → tilt degrees, dx/dy → pan.
// All settle to their delta at progress=1 (persist until next phase).
// ---------------------------------------------------------------------------

// Zoom camera by a signed delta (e.g. 0.1 for +10%).
registerPath('cameraZoomDelta', (ctx: PathContext): PathOutput => {
  const delta = Number(ctx.params.deltaScale ?? 0.1)
  return { scale: delta * ctx.easedProgress }
})

// Pan camera horizontally by delta px.
registerPath('cameraPanDelta', (ctx: PathContext): PathOutput => {
  const dx = Number(ctx.params.deltaPx ?? 60)
  return { dx: dx * ctx.easedProgress }
})

// Pan camera vertically.
registerPath('cameraPanYDelta', (ctx: PathContext): PathOutput => {
  const dy = Number(ctx.params.deltaPx ?? 40)
  return { dy: dy * ctx.easedProgress }
})

// Tilt camera by delta degrees.
registerPath('cameraTiltDelta', (ctx: PathContext): PathOutput => {
  const deg = Number(ctx.params.deltaDegrees ?? 10)
  return { rotation: deg * ctx.easedProgress }
})

// Camera pulse that returns to baseline: zoom in and back out over the action window.
registerPath('cameraZoomPulse', (ctx: PathContext): PathOutput => {
  const amp = Number(ctx.params.amplitude ?? 0.08) * (ctx.strength || 1)
  return { scale: Math.sin(ctx.easedProgress * Math.PI) * amp }
})

// Focused zoom: zooms toward a deterministic random focal point within the frame, pulling that focal
// point toward center via a coupled pan. The focal point is constrained to the sub-region that keeps
// the viewport entirely inside the frame (no out-of-bounds areas visible).
//
// Deterministic random: hashes the triggering event's absolute time (ctx.t - ctx.sinceLast).
// focusFrac ∈ [0,1] shrinks the usable range inside the mathematical in-bounds box (default 0.6).
registerPath('cameraZoomDeltaFocused', (ctx: PathContext): PathOutput => {
  const delta = Number(ctx.params.deltaScale ?? 0.1)
  const focusFrac = Math.max(0, Math.min(1, Number(ctx.params.focusFrac ?? 0.6)))
  const W = Number(ctx.params.canvasWidth ?? 1920)
  const H = Number(ctx.params.canvasHeight ?? 1080)
  const cx = W / 2
  const cy = H / 2

  // Zoom factor at full progress; for zoom-out (delta<0), Z<1 and the focal pan direction flips sign.
  const Z = 1 + delta
  if (Z <= 0) return { scale: delta * ctx.easedProgress }

  // Max displacement so viewport stays in bounds: delta_max = W * (1 - 1/Z) / 2  when Z > 1
  //                                                delta_max = W * (1/Z - 1) / 2  when Z < 1 (zoom-out can go further)
  const maxDxBound = Math.abs(W * (1 - 1 / Z) / 2)
  const maxDyBound = Math.abs(H * (1 - 1 / Z) / 2)
  const maxDx = maxDxBound * focusFrac
  const maxDy = maxDyBound * focusFrac

  // Deterministic hash seeded by event time (quantized to ms to avoid float noise).
  const eventTime = ctx.t - ctx.sinceLast
  const seed = Math.floor(eventTime * 1000) + 1
  const hx = hash01(seed * 2654435761)
  const hy = hash01(seed * 40503 + 1)
  const offsetX = (hx - 0.5) * 2 * maxDx
  const offsetY = (hy - 0.5) * 2 * maxDy
  const fx = cx + offsetX
  const fy = cy + offsetY

  // Pan to pull focal point to center as the zoom progresses.
  const dxTarget = (cx - fx) * delta
  const dyTarget = (cy - fy) * delta
  return {
    scale: delta * ctx.easedProgress,
    dx: dxTarget * ctx.easedProgress,
    dy: dyTarget * ctx.easedProgress,
  }
})
