import type { Easing, EasingName } from '../types'

// --- Named easings ---------------------------------------------------------
const C1 = 1.70158
const C2 = C1 * 1.525
const C3 = C1 + 1
const C4 = (2 * Math.PI) / 3

function easeOutBack(t: number): number {
  return 1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2)
}
function easeInOutBack(t: number): number {
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2
}
function easeOutElastic(t: number): number {
  if (t === 0) return 0
  if (t === 1) return 1
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1
}
function easeOutBounce(t: number): number {
  const n1 = 7.5625, d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75 }
  if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375 }
  const u = t - 2.625 / d1
  return n1 * u * u + 0.984375
}

export const NAMED_EASINGS: Record<EasingName, (t: number) => number> = {
  linear:          (t) => t,
  easeIn:          (t) => t * t,
  easeOut:         (t) => 1 - (1 - t) * (1 - t),
  easeInOut:       (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeOutCubic:    (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic:  (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInQuad:      (t) => t * t,
  easeOutQuad:     (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad:   (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInQuart:     (t) => t * t * t * t,
  easeOutQuart:    (t) => 1 - Math.pow(1 - t, 4),
  easeInOutQuart:  (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  easeInExpo:      (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOutExpo:     (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutExpo:   (t) => {
    if (t === 0) return 0
    if (t === 1) return 1
    return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
  },
  easeOutBack,
  easeInOutBack,
  easeOutElastic,
  easeOutBounce,
}

// --- Cubic Bezier ----------------------------------------------------------
// Standard CSS cubic-bezier(x1, y1, x2, y2) with endpoints at (0,0) and (1,1).
// Given input x in [0,1], solve for parameter s such that bezier.x(s) === x, then return bezier.y(s).
function bezierX(s: number, x1: number, x2: number): number {
  const u = 1 - s
  return 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s
}
function bezierY(s: number, y1: number, y2: number): number {
  const u = 1 - s
  return 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s
}
function bezierDerivX(s: number, x1: number, x2: number): number {
  const u = 1 - s
  return 3 * u * u * x1 + 6 * u * s * (x2 - x1) + 3 * s * s * (1 - x2)
}

export function cubicBezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
  const t = Math.max(0, Math.min(1, x))
  let s = t
  for (let i = 0; i < 10; i++) {
    const dx = bezierX(s, x1, x2) - t
    if (Math.abs(dx) < 1e-6) break
    const d = bezierDerivX(s, x1, x2)
    if (Math.abs(d) < 1e-6) break
    s = Math.max(0, Math.min(1, s - dx / d))
  }
  return bezierY(s, y1, y2)
}

// --- Public API ------------------------------------------------------------
export function applyEasing(e: Easing | undefined, x: number): number {
  const t = Math.max(0, Math.min(1, x))
  if (!e) return t
  if (typeof e === 'string') {
    const fn = NAMED_EASINGS[e]
    return fn ? fn(t) : t
  }
  if ('bezier' in e) {
    const [x1, y1, x2, y2] = e.bezier
    return cubicBezier(t, x1, y1, x2, y2)
  }
  return t
}

export function easingList(): EasingName[] {
  return Object.keys(NAMED_EASINGS) as EasingName[]
}
