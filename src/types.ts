// Shared types for scenicsynths engine, renderer, and analysis consumer.

export type Band = 'kick' | 'snare' | 'mid' | 'hats'

export const ALL_BANDS: Band[] = ['kick', 'snare', 'mid', 'hats']

export interface TransientEvent {
  t: number          // seconds from track start
  strength: number   // 0..1 normalized
}

export interface AnalysisData {
  track: string
  bpm: number
  duration: number
  sampleRate: number
  beats: number[]
  downbeats: number[]
  bands: Record<Band, TransientEvent[]>
  envelopes?: {
    fps: number
    bands: Record<Band, number[]>
  }
}

export type EasingName =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInQuart'
  | 'easeOutQuart'
  | 'easeInOutQuart'
  | 'easeInExpo'
  | 'easeOutExpo'
  | 'easeInOutExpo'
  | 'easeOutBack'
  | 'easeInOutBack'
  | 'easeOutElastic'
  | 'easeOutBounce'

export type Easing = EasingName | { bezier: [number, number, number, number] }

export interface PhaseAction {
  path: string                            // name registered in motion/paths.ts
  params?: Record<string, number | boolean | string>
  duration: number                        // seconds for progress 0 -> 1
  easing?: Easing
}

export interface PhaseSequence {
  actions: PhaseAction[]                  // length must equal ticker.modulo
}

export interface TickerConfig {
  id: string
  band: Band
  modulo: number
  strengthThreshold?: number              // default 0
  offset?: number                         // phase offset, default 0
  step?: number                           // only fire on every Nth qualifying event; default 1
  stepOffset?: number                     // index into the step cycle that first qualifies; default 0
}

export type RowSelector =
  | 'all'
  | 'even'
  | 'odd'
  | 'keyRow'
  | number[]
  | ((rowIndex: number, rowCount: number) => boolean)

export interface Binding {
  tickerId: string
  target?: 'rows' | 'camera'                     // default 'rows'
  rows?: RowSelector                             // only when target === 'rows'; default 'all'
  sequence: PhaseSequence
  compose?: 'add' | 'multiply' | 'override'    // default 'add'
  respectAlternation?: boolean                  // default true (rows only)
}

export interface PathContext {
  rowIndex: number
  rowCount: number
  dir: 1 | -1
  progress: number        // 0..1 across the active action's duration
  easedProgress: number   // progress after easing
  strength: number        // 0..1
  phase: number           // current ticker phase
  t: number               // global time (s)
  sinceLast: number       // seconds since triggering event
  params: Record<string, number | boolean | string>
}

export interface PerGlyphOutput {
  dx?: number
  dy?: number
  scale?: number
  rotation?: number
  opacity?: number
}

export interface PathOutput {
  dx?: number
  dy?: number
  scale?: number           // multiplicative when composed with multiply, additive-to-1 when composed add
  rotation?: number
  opacity?: number         // multiplicative (0..1)
  tracking?: number        // extra px between glyphs
  perGlyph?: (glyphIndex: number) => PerGlyphOutput
}

export type PathFn = (ctx: PathContext) => PathOutput

export interface RowMotionState {
  dx: number
  dy: number
  scale: number
  rotation: number
  opacity: number
  tracking: number
  perGlyph?: ((glyphIndex: number) => PerGlyphOutput)[]
}

export interface TickerSnapshot {
  id: string
  band: Band
  count: number
  phase: number
  sinceLast: number
  strength: number
  progress: number        // of the current action
  activeAction: PhaseAction | null
}

export interface CameraState {
  zoom: number        // 1 = 100%; paths emit a delta around 0 that is added to 1 (via compose rules identical to rows.scale)
  panX: number        // pixels
  panY: number        // pixels
  tilt: number        // degrees
}

export interface FrameState {
  t: number
  rows: RowMotionState[]
  tickers: TickerSnapshot[]
  camera: CameraState
}

export interface Config {
  text: {
    unit: string                     // 'scenicsynth' (the repeating 11-glyph unit)
    key: string                      // 'scenicsynths' (12 glyphs; wraps the shared s)
    case: 'lower' | 'upper' | 'as-is'
  }
  layout: {
    fontSizePx: number
    leadingPx: number                // vertical spacing between rows (center-to-center) if > 0, otherwise auto from font
    rows: number | 'auto'            // 'auto' => fit frame
    rowStaggerPx: number             // random-ish stagger magnitude per row (deterministic)
    rotationDeg: number              // global rotation about frame center
    marginPx: number                 // vertical margin top+bottom
  }
  colors: {
    background: string
    dim: string
    key: string
  }
  key: {
    rows: 'all' | 'even' | 'odd' | 'single'   // which rows host spotlights
    singleRow: number | 'middle'              // only used when rows === 'single'; also what bindings resolve 'keyRow' to
    frequency: number                         // spotlight every N units (ignored when rows === 'single')
    offsetUnits: number                       // base unit-index offset of the first spotlight
    rowPhaseOffset: boolean                   // scatter spotlight phase per row so columns don't line up vertically
    mode: 'travels' | 'anchored'
    anchorScreenOffsetPx: number              // for anchored mode: pixel offset of the first on-screen window
  }
  canvas: {
    width: number
    height: number
    dpr: number
    renderScale: number                 // extra multiplier on physical pixels beyond devicePixelRatio (sharper, costlier)
  }
  audio: {
    track: string | null             // basename of audio file without extension
    analysisUrl: string | null       // override: path to analysis JSON
  }
  tickers: TickerConfig[]
  bindings: Binding[]
  bandThresholds: Record<Band, number>  // runtime strength filter per band
  camera: {
    baseline: { zoom: number; panX: number; panY: number; tilt: number }
    rowOvershoot: number                // extra rows to render above and below canvas to fill zoom/tilt
  }
  feel: {
    preset: FeelPreset
    durationScale: number               // multiplies every action duration (0.1..3)
    globalEasing: EasingName | 'auto'   // 'auto' = use per-action easing; else overrides
    horizontalScale: number             // multiplies every horizontal motion (dx + perGlyph.dx) globally; 1.0 = default
    rowVelocityShape: 'flat' | 'u' | 'inverted-u' | 'linear'  // per-row horizontal speed curve
    rowVelocityEdgeScale: number        // scale at the extreme row(s) relative to center; 2.0 = 2× faster
  }
  record: {
    startAt: number                     // seconds into the track
    duration: number                    // seconds to capture
    fps: 24 | 30 | 60
    videoBitrateMbps: number            // webm vp9 / mp4 h264 bitrate
    resolutionMultiplier: number        // extra scale on canvas resolution during record only (2 = 2× sharper)
    engine: 'webcodecs' | 'mediarecorder' | 'auto'  // which recorder path to use
    renderSlowdown: number              // pacing: wall seconds per frame = slowdown / fps. 1 = real time; higher gives GPU more time.
  }
  debug: {
    hud: boolean
  }
}

export type FeelPreset = 'custom' | 'default' | 'snappy' | 'smooth' | 'punchy' | 'glacial' | 'bouncy'
