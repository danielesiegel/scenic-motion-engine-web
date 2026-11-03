import type { Config, FrameState, PerGlyphOutput } from '../types'
import type { UnitLayout } from '../text/layout'
import { glyphChar, glyphX, visibleGlyphRange } from '../text/layout'
import { FONT_FAMILY } from '../text/font'

// Deterministic small hash in [0,1) by integer seed.
function hash01(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return ((h >>> 0) % 1_000_003) / 1_000_003
}

export interface RenderInputs {
  ctx: CanvasRenderingContext2D
  state: FrameState
  config: Config
  layout: UnitLayout
  rowCount: number
  keyRow: number
}

export interface RowGeometry {
  baseScrollX: number     // horizontal placement for p=0 if dx=0
  y: number               // baseline y (alphabetic) for the row
}

export function computeRowLineHeight(config: Config, layout: UnitLayout): number {
  return config.layout.leadingPx > 0 ? config.layout.leadingPx : layout.lineHeight
}

export function computeAutoRowCount(config: Config, layout: UnitLayout): number {
  const h = config.canvas.height - 2 * config.layout.marginPx
  const lh = computeRowLineHeight(config, layout)
  if (lh <= 0) return 1
  // Overshoot so rows extend past the canvas edges — covers camera zoom-out, tilt, and sub-pixel gaps.
  const base = Math.ceil(h / lh)
  const extra = Math.max(0, Math.floor(config.camera.rowOvershoot ?? 0))
  return Math.max(1, base + 2 * extra)
}

export function keyRowFromConfig(config: Config, rowCount: number): number {
  // The "primary" key row, used by bindings that select rows: 'keyRow' and by legacy single-spotlight mode.
  if (config.key.singleRow === 'middle') return Math.floor(rowCount / 2)
  return Math.max(0, Math.min(rowCount - 1, config.key.singleRow))
}

export function keyWidth(layout: UnitLayout): number {
  // Width from glyph index 0 (start s) to glyph index 12 (one past end s). Since
  // (12 % 11) === 1, this is stride + unitPos[1].
  return layout.stride + layout.unitPos[1]
}

// Which rows get spotlights at all.
export function rowGetsSpotlight(config: Config, rowIndex: number, keyRow: number): boolean {
  switch (config.key.rows) {
    case 'all':    return true
    case 'even':   return rowIndex % 2 === 0
    case 'odd':    return rowIndex % 2 === 1
    case 'single': return rowIndex === keyRow
    default:       return false
  }
}

// Deterministic per-row unit-phase offset in [0, frequency), used when rowPhaseOffset is on.
function rowPhaseUnits(rowIndex: number, frequency: number): number {
  // Reuse hash01 seed convention from this file.
  const h = hash01(rowIndex * 2246822519)
  return Math.floor(h * Math.max(1, frequency))
}

// Returns true if glyph index `p` lies within any spotlight band for this row (travels mode).
export function isKeyGlyphTravels(
  config: Config,
  rowIndex: number,
  keyRow: number,
  p: number,
  unitLength: number,
): boolean {
  if (!rowGetsSpotlight(config, rowIndex, keyRow)) return false
  if (config.key.rows === 'single') {
    const start = config.key.offsetUnits * unitLength
    return p >= start && p <= start + unitLength
  }
  const N = Math.max(1, Math.floor(config.key.frequency))
  const phaseUnits = config.key.rowPhaseOffset ? rowPhaseUnits(rowIndex, N) : 0
  const period = N * unitLength
  // Shift p so a spotlight start lands on 0, then test if we're within the first (unitLength + 1) glyphs.
  // Spotlight starts live at unitIndex ∈ {offsetUnits + phaseUnits + k*N : k ∈ ℤ}, i.e. glyph index k*period + base.
  const base = (config.key.offsetUnits + phaseUnits) * unitLength
  const shifted = ((p - base) % period + period) % period
  return shifted <= unitLength
}

// Returns true if glyph center-x sits inside an anchored spotlight window (anchored mode).
export function isKeyGlyphAnchored(
  config: Config,
  rowIndex: number,
  keyRow: number,
  centerX: number,
  layout: UnitLayout,
  frameWidth: number,
): boolean {
  if (!rowGetsSpotlight(config, rowIndex, keyRow)) return false
  const kw = keyWidth(layout)
  if (config.key.rows === 'single') {
    // Legacy behavior: one window centered horizontally with anchorScreenOffsetPx shift.
    const left = frameWidth / 2 - kw / 2 + config.key.anchorScreenOffsetPx
    return centerX >= left && centerX <= left + kw
  }
  const N = Math.max(1, Math.floor(config.key.frequency))
  const spacing = N * layout.stride
  const phasePx = config.key.rowPhaseOffset ? rowPhaseUnits(rowIndex, N) * layout.stride : 0
  const anchorStart = config.key.anchorScreenOffsetPx + config.key.offsetUnits * layout.stride + phasePx
  const offsetX = (((centerX - anchorStart) % spacing) + spacing) % spacing
  return offsetX <= kw
}

export function computeRowGeometry(
  rowIndex: number,
  rowCount: number,
  config: Config,
  layout: UnitLayout,
  keyRow: number,
): RowGeometry {
  const lh = computeRowLineHeight(config, layout)
  const totalHeight = rowCount * lh
  const centerY = config.canvas.height / 2
  const topY = centerY - totalHeight / 2
  const y = topY + rowIndex * lh + layout.ascent

  let baseScrollX: number
  if (config.key.rows === 'single' && rowIndex === keyRow) {
    // In legacy single-spotlight mode, center the key horizontally on first paint.
    const kw = keyWidth(layout)
    const kStart = config.key.offsetUnits * layout.unitLength
    baseScrollX = config.canvas.width / 2 - kw / 2 - glyphX(kStart, layout)
  } else {
    // Deterministic stagger per row, in [0, stride).
    const stagger = hash01(rowIndex * 2654435761) * layout.stride * config.layout.rowStaggerPx
    baseScrollX = -stagger
  }

  return { baseScrollX, y }
}

function applyCase(ch: string, mode: Config['text']['case']): string {
  if (mode === 'upper') return ch.toUpperCase()
  if (mode === 'lower') return ch.toLowerCase()
  return ch
}

export function render({ ctx, state, config, layout, rowCount, keyRow }: RenderInputs): void {
  const { width, height, dpr } = config.canvas
  const renderScale = Math.max(1, config.canvas.renderScale || 1)
  const effectiveScale = dpr * renderScale

  ctx.save()
  ctx.setTransform(effectiveScale, 0, 0, effectiveScale, 0, 0)
  ctx.fillStyle = config.colors.background
  ctx.fillRect(0, 0, width, height)

  // Camera transform: outermost — baseline + per-frame deltas; zoom + tilt about frame center, then pan.
  const cam = state.camera
  const base = config.camera.baseline
  const camZoom = Math.max(0.01, cam.zoom * (base.zoom || 1))
  const camTilt = cam.tilt + base.tilt + config.layout.rotationDeg
  const camPanX = cam.panX + base.panX
  const camPanY = cam.panY + base.panY
  if (camZoom !== 1 || camTilt !== 0 || camPanX !== 0 || camPanY !== 0) {
    ctx.translate(width / 2 + camPanX, height / 2 + camPanY)
    ctx.rotate((camTilt * Math.PI) / 180)
    ctx.scale(camZoom, camZoom)
    ctx.translate(-width / 2, -height / 2)
  }

  const fontSize = config.layout.fontSizePx
  ctx.font = `${fontSize}px "${FONT_FAMILY}", "ITC Avant Garde Gothic LT Demi", "URW Gothic Demi", "TeX Gyre Adventor Bold", sans-serif`
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  for (let r = 0; r < rowCount; r++) {
    const rowState = state.rows[r]
    const { baseScrollX, y } = computeRowGeometry(r, rowCount, config, layout, keyRow)
    const scrollX = baseScrollX + rowState.dx
    const rowY = y + rowState.dy

    ctx.save()
    // Row-level transform: rotation and scale about row center.
    const rowCenterX = width / 2
    const rowCenterY = rowY - layout.ascent / 2
    if (rowState.rotation !== 0 || rowState.scale !== 1) {
      ctx.translate(rowCenterX, rowCenterY)
      ctx.rotate((rowState.rotation * Math.PI) / 180)
      ctx.scale(rowState.scale, rowState.scale)
      ctx.translate(-rowCenterX, -rowCenterY)
    }
    const rowOpacity = Math.max(0, Math.min(1, rowState.opacity))

    const [pMin, pMax] = visibleGlyphRange(scrollX, -layout.stride, width + layout.stride, layout)
    const tracking = rowState.tracking

    for (let p = pMin; p <= pMax; p++) {
      let x = scrollX + glyphX(p, layout) + p * tracking
      let gy = rowY
      let gScale = 1
      let gOpacity = 1
      let gRot = 0
      if (rowState.perGlyph) {
        for (const fn of rowState.perGlyph) {
          const d: PerGlyphOutput = fn(p)
          if (d.dx !== undefined) x += d.dx
          if (d.dy !== undefined) gy += d.dy
          if (d.scale !== undefined) gScale += d.scale
          if (d.opacity !== undefined) gOpacity += d.opacity
          if (d.rotation !== undefined) gRot += d.rotation
        }
      }

      let isKey = false
      if (config.key.mode === 'travels') {
        isKey = isKeyGlyphTravels(config, r, keyRow, p, layout.unitLength)
      } else {
        const advance = glyphX(p + 1, layout) - glyphX(p, layout)
        const centerX = x + advance / 2
        isKey = isKeyGlyphAnchored(config, r, keyRow, centerX, layout, width)
      }

      ctx.globalAlpha = rowOpacity * Math.max(0, Math.min(1, gOpacity))
      ctx.fillStyle = isKey ? config.colors.key : config.colors.dim

      const ch = applyCase(glyphChar(p, layout), config.text.case)
      // Snap draw position to a sub-pixel grid consistent across frames. At effectiveScale ≥ 2 we snap to
      // half-CSS-px (which is 1 physical px), so the glyph rasterizes to the same bitmap when motion is
      // slower than one physical pixel per frame — kills shimmer. For 1x displays we snap to 1 CSS px.
      const snap = effectiveScale >= 2 ? 0.5 : 1
      const sx = Math.round(x / snap) * snap
      const sy = Math.round(gy / snap) * snap
      if (gRot !== 0 || gScale !== 1) {
        ctx.save()
        ctx.translate(sx, sy)
        ctx.rotate((gRot * Math.PI) / 180)
        ctx.scale(gScale, gScale)
        ctx.fillText(ch, 0, 0)
        ctx.restore()
      } else {
        ctx.fillText(ch, sx, sy)
      }
    }

    ctx.globalAlpha = 1
    ctx.restore()
  }

  ctx.restore()
}
