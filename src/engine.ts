import type { EventSource } from './audio/eventSource'
import type {
  Band,
  Binding,
  CameraState,
  Config,
  Easing,
  FrameState,
  PathContext,
  PathOutput,
  PhaseAction,
  PhaseSequence,
  PerGlyphOutput,
  RowMotionState,
  TickerConfig,
  TickerSnapshot,
  TransientEvent,
} from './types'
import type { UnitLayout } from './text/layout'
import { getPath } from './motion/paths'
import { applyEasing } from './motion/phase'
import { resolveThreshold, type TickerResolved } from './motion/tickers'
import { resolveBindings } from './motion/bindings'

export interface EngineInputs {
  t: number
  config: Config
  source: EventSource
  layout: UnitLayout
  rowCount: number
  keyRow: number
}

function emptyRow(): RowMotionState {
  return { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1, tracking: 0 }
}
function emptyCamera(): CameraState {
  return { zoom: 1, panX: 0, panY: 0, tilt: 0 }
}

function composeInto(state: RowMotionState, out: PathOutput, mode: 'add' | 'multiply' | 'override'): void {
  if (out.dx !== undefined) {
    if (mode === 'override') state.dx = out.dx
    else if (mode === 'multiply') state.dx *= out.dx
    else state.dx += out.dx
  }
  if (out.dy !== undefined) {
    if (mode === 'override') state.dy = out.dy
    else if (mode === 'multiply') state.dy *= out.dy
    else state.dy += out.dy
  }
  if (out.scale !== undefined) {
    if (mode === 'override') state.scale = 1 + out.scale
    else if (mode === 'multiply') state.scale *= 1 + out.scale
    else state.scale *= 1 + out.scale
  }
  if (out.rotation !== undefined) {
    if (mode === 'override') state.rotation = out.rotation
    else if (mode === 'multiply') state.rotation *= out.rotation
    else state.rotation += out.rotation
  }
  if (out.opacity !== undefined) {
    if (mode === 'override') state.opacity = 1 + out.opacity
    else if (mode === 'multiply') state.opacity *= 1 + out.opacity
    else state.opacity = Math.max(0, Math.min(1, state.opacity + out.opacity))
  }
  if (out.tracking !== undefined) {
    if (mode === 'override') state.tracking = out.tracking
    else if (mode === 'multiply') state.tracking *= out.tracking
    else state.tracking += out.tracking
  }
  if (out.perGlyph) {
    state.perGlyph = state.perGlyph ?? []
    state.perGlyph.push(out.perGlyph)
  }
}

function composeCamera(cam: CameraState, out: PathOutput, mode: 'add' | 'multiply' | 'override'): void {
  if (out.dx !== undefined) {
    if (mode === 'override') cam.panX = out.dx
    else cam.panX += out.dx
  }
  if (out.dy !== undefined) {
    if (mode === 'override') cam.panY = out.dy
    else cam.panY += out.dy
  }
  if (out.scale !== undefined) {
    // scale is a delta around 0; camera.zoom baseline is 1.
    if (mode === 'override') cam.zoom = 1 + out.scale
    else if (mode === 'multiply') cam.zoom *= 1 + out.scale
    else cam.zoom *= 1 + out.scale
  }
  if (out.rotation !== undefined) {
    if (mode === 'override') cam.tilt = out.rotation
    else cam.tilt += out.rotation
  }
}

function buildCtx(
  t: number,
  action: PhaseAction,
  effectiveEasing: Easing | undefined,
  effectiveDuration: number,
  rowIndex: number,
  rowCount: number,
  dir: 1 | -1,
  progress: number,
  strength: number,
  phase: number,
  sinceLast: number,
  layout: UnitLayout,
  config: Config,
): PathContext {
  const easedProgress = applyEasing(effectiveEasing, progress)
  const params = {
    ...(action.params ?? {}),
    unitWidth: layout.stride,
    duration: effectiveDuration,
    rowCount,
    rowIndex,
    canvasWidth: config.canvas.width,
    canvasHeight: config.canvas.height,
  }
  return {
    rowIndex,
    rowCount,
    dir,
    progress,
    easedProgress,
    strength,
    phase,
    t,
    sinceLast,
    params,
  }
}

function applyDir(out: PathOutput, dir: 1 | -1, respectAlternation: boolean): PathOutput {
  if (!respectAlternation || dir === 1) return out
  const next: PathOutput = { ...out }
  if (next.dx !== undefined) next.dx *= dir
  if (next.perGlyph) {
    const orig = next.perGlyph
    next.perGlyph = (g: number) => {
      const r = orig(g)
      return { ...r, dx: r.dx !== undefined ? r.dx * dir : undefined }
    }
  }
  return next
}

interface TickerResolvedBound extends TickerResolved { lookup: Record<Band, number> }

function resolveTickers(config: Config): Map<string, TickerResolvedBound> {
  const out = new Map<string, TickerResolvedBound>()
  for (const t of config.tickers) {
    out.set(t.id, {
      config: t,
      band: t.band,
      modulo: t.modulo,
      offset: t.offset ?? 0,
      effectiveThreshold: resolveThreshold(t, config.bandThresholds),
      lookup: config.bandThresholds,
    })
  }
  return out
}

function effectiveActionTiming(
  action: PhaseAction,
  config: Config,
): { duration: number; easing: Easing | undefined } {
  const scale = Math.max(0.01, config.feel.durationScale)
  const duration = Math.max(1e-6, action.duration * scale)
  const easing: Easing | undefined =
    config.feel.globalEasing === 'auto' ? action.easing : config.feel.globalEasing
  return { duration, easing }
}

// Return the subsampled event list for a ticker (every stepth event after stepOffset).
function stepFilter(events: TransientEvent[], step: number, stepOffset: number): TransientEvent[] {
  const s = Math.max(1, Math.floor(step))
  const o = ((Math.floor(stepOffset) % s) + s) % s
  if (s === 1 && o === 0) return events
  const out: TransientEvent[] = []
  for (let i = 0; i < events.length; i++) {
    if (((i - o) % s + s) % s === 0 && i >= o) out.push(events[i])
  }
  return out
}

function evaluateBindingContributions(
  t: number,
  binding: Binding,
  tickerCfg: TickerConfig,
  sequence: PhaseSequence,
  source: EventSource,
  rowIndex: number,
  rowCount: number,
  dir: 1 | -1,
  layout: UnitLayout,
  effectiveThreshold: number,
  config: Config,
): PathOutput {
  const modulo = Math.max(1, tickerCfg.modulo)
  const offset = tickerCfg.offset ?? 0
  const step = tickerCfg.step ?? 1
  const stepOffset = tickerCfg.stepOffset ?? 0

  const events = source.getEvents(tickerCfg.band)
  const thresholded = effectiveThreshold > 0 ? events.filter((e) => e.strength >= effectiveThreshold) : events
  const filtered = stepFilter(thresholded, step, stepOffset)

  let lastIdx = -1
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].t <= t) { lastIdx = i; break }
  }
  if (lastIdx < 0 || sequence.actions.length === 0) return {}

  const running: PathOutput = {}
  const perGlyphFns: ((g: number) => PerGlyphOutput)[] = []

  const applyToRunning = (out: PathOutput) => {
    if (out.dx !== undefined) running.dx = (running.dx ?? 0) + out.dx
    if (out.dy !== undefined) running.dy = (running.dy ?? 0) + out.dy
    if (out.scale !== undefined) running.scale = (running.scale ?? 0) + out.scale
    if (out.rotation !== undefined) running.rotation = (running.rotation ?? 0) + out.rotation
    if (out.opacity !== undefined) running.opacity = (running.opacity ?? 0) + out.opacity
    if (out.tracking !== undefined) running.tracking = (running.tracking ?? 0) + out.tracking
    if (out.perGlyph) perGlyphFns.push(out.perGlyph)
  }

  const respectAlt = (binding.respectAlternation ?? true) && (binding.target ?? 'rows') === 'rows'

  for (let i = 0; i < lastIdx; i++) {
    const phase = ((i + offset) % modulo + modulo) % modulo
    const action = sequence.actions[phase % sequence.actions.length]
    const pathFn = getPath(action.path)
    if (!pathFn) continue
    const { duration, easing } = effectiveActionTiming(action, config)
    const gap = filtered[i + 1].t - filtered[i].t
    const frozenProgress = Math.max(0, Math.min(1, gap / duration))
    const ctx = buildCtx(t, action, easing, duration, rowIndex, rowCount, dir, frozenProgress, filtered[i].strength, phase, t - filtered[i].t, layout, config)
    const out = applyDir(pathFn(ctx), dir, respectAlt)
    applyToRunning(out)
  }

  const activePhase = ((lastIdx + offset) % modulo + modulo) % modulo
  const activeAction = sequence.actions[activePhase % sequence.actions.length]
  const activeFn = getPath(activeAction.path)
  if (activeFn) {
    const { duration, easing } = effectiveActionTiming(activeAction, config)
    const progress = Math.max(0, Math.min(1, (t - filtered[lastIdx].t) / duration))
    const ctx = buildCtx(t, activeAction, easing, duration, rowIndex, rowCount, dir, progress, filtered[lastIdx].strength, activePhase, t - filtered[lastIdx].t, layout, config)
    const out = applyDir(activeFn(ctx), dir, respectAlt)
    applyToRunning(out)
  }

  if (perGlyphFns.length > 0) {
    running.perGlyph = (g: number) => {
      const acc: PerGlyphOutput = {}
      for (const fn of perGlyphFns) {
        const r = fn(g)
        if (r.dx !== undefined) acc.dx = (acc.dx ?? 0) + r.dx
        if (r.dy !== undefined) acc.dy = (acc.dy ?? 0) + r.dy
        if (r.scale !== undefined) acc.scale = (acc.scale ?? 0) + r.scale
        if (r.rotation !== undefined) acc.rotation = (acc.rotation ?? 0) + r.rotation
        if (r.opacity !== undefined) acc.opacity = (acc.opacity ?? 0) + r.opacity
      }
      return acc
    }
  }

  return running
}

// Per-row velocity shaping: scale factor for row `i` of `n`, driven by config.feel.rowVelocityShape.
// p = row's normalized vertical position in [0, 1] (0 = top, 1 = bottom).
// - 'flat'       : always 1
// - 'u'          : 1 + (edge - 1) * (2p - 1)^2  → 1 at center, `edge` at both ends
// - 'inverted-u' : edge - (edge - 1) * (2p - 1)^2 → `edge` at center, 1 at both ends
// - 'linear'     : lerp from `edge` at top to 1 at bottom
function rowVelocityScale(rowIndex: number, rowCount: number, config: Config): number {
  const shape = config.feel.rowVelocityShape
  const edge = Number.isFinite(config.feel.rowVelocityEdgeScale) ? config.feel.rowVelocityEdgeScale : 1
  if (shape === 'flat' || rowCount <= 1 || edge === 1) return 1
  const p = rowIndex / (rowCount - 1)       // 0..1
  const q = 2 * p - 1                        // -1..1
  switch (shape) {
    case 'u':          return 1 + (edge - 1) * q * q
    case 'inverted-u': return edge - (edge - 1) * q * q
    case 'linear':     return edge + (1 - edge) * p
    default:           return 1
  }
}

// Apply the global horizontal-motion scale factor to a PathOutput's horizontal components.
function scaleHorizontal(out: PathOutput, hScale: number): PathOutput {
  if (hScale === 1) return out
  const next: PathOutput = { ...out }
  if (next.dx !== undefined) next.dx *= hScale
  if (next.tracking !== undefined) next.tracking *= hScale
  if (next.perGlyph) {
    const orig = next.perGlyph
    next.perGlyph = (g: number) => {
      const r = orig(g)
      return { ...r, dx: r.dx !== undefined ? r.dx * hScale : undefined }
    }
  }
  return next
}

export function evaluate(inp: EngineInputs): FrameState {
  const { t, config, source, layout, rowCount, keyRow } = inp

  const rows: RowMotionState[] = Array.from({ length: rowCount }, emptyRow)
  const camera: CameraState = emptyCamera()
  const hScale = Math.max(0, config.feel.horizontalScale ?? 1)
  const resolvedBindings = resolveBindings(config.bindings, rowCount, keyRow)
  const resolvedTickers = resolveTickers(config)
  const tickers: TickerSnapshot[] = []

  for (const t_cfg of config.tickers) {
    const resolved = resolvedTickers.get(t_cfg.id)
    if (!resolved) continue
    const seq = config.bindings.find((b) => b.tickerId === t_cfg.id)?.sequence
    const rawEvents = source.getEvents(t_cfg.band)
    const thresholded = resolved.effectiveThreshold > 0
      ? rawEvents.filter((e) => e.strength >= resolved.effectiveThreshold)
      : rawEvents
    const stepped = stepFilter(thresholded, t_cfg.step ?? 1, t_cfg.stepOffset ?? 0)
    let latestIdx = -1
    for (let i = stepped.length - 1; i >= 0; i--) { if (stepped[i].t <= t) { latestIdx = i; break } }
    const latest = latestIdx >= 0 ? stepped[latestIdx] : null
    const phase = latestIdx >= 0 ? ((latestIdx + resolved.offset) % resolved.modulo + resolved.modulo) % resolved.modulo : (resolved.offset % resolved.modulo)
    const action = seq?.actions[phase] ?? null
    const effective = action ? effectiveActionTiming(action, config) : null
    const sinceLast = latest ? t - latest.t : Infinity
    const progress = effective ? Math.max(0, Math.min(1, sinceLast / effective.duration)) : 0
    tickers.push({
      id: t_cfg.id,
      band: t_cfg.band,
      count: latestIdx + 1,
      phase,
      sinceLast,
      strength: latest?.strength ?? 0,
      progress,
      activeAction: action,
    })
  }

  for (const rb of resolvedBindings) {
    const binding = rb.binding
    const tCfg = config.tickers.find((x) => x.id === binding.tickerId)
    if (!tCfg) continue
    const resolvedT = resolvedTickers.get(tCfg.id)
    if (!resolvedT) continue
    const mode = binding.compose ?? 'add'
    const target = binding.target ?? 'rows'

    if (target === 'camera') {
      const out = evaluateBindingContributions(
        t, binding, tCfg, binding.sequence, source,
        0, rowCount, 1, layout, resolvedT.effectiveThreshold, config,
      )
      composeCamera(camera, scaleHorizontal(out, hScale), mode)
      continue
    }

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      if (!rb.rows[rowIndex]) continue
      const dir: 1 | -1 = rowIndex % 2 === 0 ? 1 : -1
      const out = evaluateBindingContributions(
        t, binding, tCfg, binding.sequence, source,
        rowIndex, rowCount, dir, layout, resolvedT.effectiveThreshold, config,
      )
      const rowScale = hScale * rowVelocityScale(rowIndex, rowCount, config)
      composeInto(rows[rowIndex], scaleHorizontal(out, rowScale), mode)
    }
  }

  return { t, rows, tickers, camera }
}
