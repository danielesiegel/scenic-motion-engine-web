import opentype from 'opentype.js'

// Candidate font paths. User drops the real file in assets/fonts/.
const AVANT_GARDE_CANDIDATES = [
  '/assets/fonts/ITCAvantGardeGothicLTDemi.otf',
  '/assets/fonts/ITC-Avant-Garde-Gothic-LT-Demi.otf',
  '/assets/fonts/ITCAvantGardeStd-Demi.otf',
  '/assets/fonts/ITCAvantGardeGothicLTDemi.ttf',
  '/assets/fonts/ITC Avant Garde Gothic LT Demi.otf',
  '/assets/fonts/ITC Avant Garde Gothic LT Demi.ttf',
  '/assets/fonts/AvantGarde-Demi.otf',
  '/assets/fonts/AvantGarde-Demi.ttf',
]

const FALLBACK_CANDIDATES = [
  '/assets/fonts/URWGothic-Demi.otf',
  '/assets/fonts/URWGothic-Demi.ttf',
  '/assets/fonts/texgyreadventor-bold.otf',
  '/assets/fonts/texgyreadventor-bold.ttf',
  '/assets/fonts/TeXGyreAdventor-Bold.otf',
]

export const FONT_FAMILY = 'scenicsynths-font'

// A font file starts with one of: 'OTTO' (OpenType CFF), 0x00010000 (TrueType), 'ttcf' (collection),
// 'wOFF' (WOFF), 'wOF2' (WOFF2). Vite's dev server returns index.html with status 200 for missing
// paths (SPA fallback), so a content-type / magic-number check is required to avoid false positives.
function isFontBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false
  const v = new DataView(buf)
  const b0 = v.getUint8(0), b1 = v.getUint8(1), b2 = v.getUint8(2), b3 = v.getUint8(3)
  const tag = String.fromCharCode(b0, b1, b2, b3)
  if (tag === 'OTTO' || tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2') return true
  // TrueType: 0x00010000
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return true
  // 'true' and 'typ1' are legacy TrueType.
  if (tag === 'true' || tag === 'typ1') return true
  return false
}

async function tryFetch(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (!isFontBuffer(buf)) return null
    return buf
  } catch {
    return null
  }
}

export interface LoadedFont {
  font: opentype.Font
  source: 'primary' | 'fallback'
  url: string
  cssFamily: string
}

async function registerCssFont(buf: ArrayBuffer, family: string): Promise<void> {
  // Use the raw ArrayBuffer form of FontFace. This loads independently of CSS @font-face.
  const face = new FontFace(family, buf)
  await face.load()
  ;(document as unknown as { fonts: FontFaceSet }).fonts.add(face)
}

export async function loadFont(): Promise<LoadedFont> {
  for (const url of AVANT_GARDE_CANDIDATES) {
    const buf = await tryFetch(url)
    if (!buf) continue
    const font = opentype.parse(buf)
    await registerCssFont(buf.slice(0), FONT_FAMILY)
    return { font, source: 'primary', url, cssFamily: FONT_FAMILY }
  }
  for (const url of FALLBACK_CANDIDATES) {
    const buf = await tryFetch(url)
    if (!buf) continue
    const font = opentype.parse(buf)
    await registerCssFont(buf.slice(0), FONT_FAMILY)
    // eslint-disable-next-line no-console
    console.warn(
      `[scenicsynths] Primary font (ITC Avant Garde Gothic LT Demi) not found in assets/fonts/. ` +
        `Falling back to ${url}. Drop the correct .otf/.ttf into assets/fonts/ to use the real face.`,
    )
    return { font, source: 'fallback', url, cssFamily: FONT_FAMILY }
  }
  throw new Error(
    '[scenicsynths] No font available. Drop ITC Avant Garde Gothic LT Demi (.otf or .ttf) into assets/fonts/, ' +
      'or any Avant-Garde-like fallback such as URW Gothic Demi / TeX Gyre Adventor Bold.',
  )
}
