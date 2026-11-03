import type opentype from 'opentype.js'

// Shaping for the repeating marquee. The user text is 'scenicsynths' (12 chars) with a shared 's'
// so the repeating unit is 'scenicsynth' (11 chars). We compute per-glyph x positions for one unit,
// baking in the kern between the last 'h' and the first 's' of the next unit, so an endless stream
// is just (unitIndex * stride + unitPos[g % 11]).

export interface UnitLayout {
  unit: string              // the 11-char repeating unit
  unitLength: number        // === 11 for 'scenicsynth'
  stride: number            // horizontal distance from glyph index 0 to glyph index 11 (next 's')
  unitPos: number[]         // length 11; x position of glyph g in [0, stride)
  ascent: number            // in px
  descent: number           // in px (positive magnitude)
  lineHeight: number        // ascent + descent (bare), in px
  xHeight: number
  capHeight: number
  size: number              // the font size this layout was built at
  font: opentype.Font
}

// Build the unit layout at a specific font size.
export function buildUnitLayout(font: opentype.Font, size: number, unit = 'scenicsynth'): UnitLayout {
  if (unit.length < 2) throw new Error('unit must have at least 2 chars')
  // Shape 'unit + first-char-of-unit' so we can measure the stride including the inter-unit kern.
  const shapedString = unit + unit[0]
  const scale = size / font.unitsPerEm

  // opentype's Font.getPath returns a Path, but we want per-glyph positions. Use getAdvanceWidth and
  // getKerningValue instead for a deterministic layout.
  const glyphs = font.stringToGlyphs(shapedString)
  const positions: number[] = new Array(shapedString.length).fill(0)
  for (let i = 1; i < shapedString.length; i++) {
    const prev = glyphs[i - 1]
    const curr = glyphs[i]
    const advancePrev = prev.advanceWidth ?? font.unitsPerEm
    let kern = 0
    try {
      kern = font.getKerningValue ? font.getKerningValue(prev, curr) || 0 : 0
    } catch {
      kern = 0
    }
    positions[i] = positions[i - 1] + (advancePrev + kern) * scale
  }
  const stride = positions[unit.length] // position of the (unit.length)-th glyph, i.e. first glyph of the next unit
  const unitPos = positions.slice(0, unit.length)

  const ascent = (font.ascender ?? font.unitsPerEm) * scale
  const descent = Math.abs(font.descender ?? 0) * scale
  const lineHeight = ascent + descent

  // Try to pull xHeight / capHeight from OS/2 if present, else estimate.
  // Narrow via feature detection — different builds of opentype.js expose tables under slightly different keys.
  const tables = (font as unknown as { tables?: Record<string, unknown> }).tables
  const os2 = (tables?.os2 ?? {}) as Record<string, number | undefined>
  const xHeight = (os2.sxHeight ?? font.unitsPerEm * 0.5) * scale
  const capHeight = (os2.sCapHeight ?? font.unitsPerEm * 0.7) * scale

  return { unit, unitLength: unit.length, stride, unitPos, ascent, descent, lineHeight, xHeight, capHeight, size, font }
}

// Position of glyph index `p` in the infinite stream (p = 0 is the first 's').
export function glyphX(p: number, layout: UnitLayout): number {
  const n = layout.unitLength
  // JS % may be negative for negative p; normalize.
  const idx = ((p % n) + n) % n
  const unitIdx = Math.floor(p / n)
  return unitIdx * layout.stride + layout.unitPos[idx]
}

// The character at glyph index p in the infinite stream.
export function glyphChar(p: number, layout: UnitLayout): string {
  const n = layout.unitLength
  const idx = ((p % n) + n) % n
  return layout.unit[idx]
}

// For a given visible x-range [xMin, xMax] of a row, return [pStart, pEnd] (inclusive)
// such that drawing those glyphs covers the range. We treat scrollOffset as the screen-space x of glyph index 0.
export function visibleGlyphRange(scrollOffset: number, xMin: number, xMax: number, layout: UnitLayout): [number, number] {
  // Screen x of glyph p = scrollOffset + glyphX(p). Find p such that this is within [xMin, xMax].
  // Rough bounds: p ≈ (x - scrollOffset) / avgAdvance; use stride/unitLength as average.
  const avg = layout.stride / layout.unitLength
  const pMin = Math.floor((xMin - scrollOffset) / avg) - 2
  const pMax = Math.ceil((xMax - scrollOffset) / avg) + 2
  return [pMin, pMax]
}
