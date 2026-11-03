import { Pane } from 'tweakpane'
import type { Config, Band, EasingName, FeelPreset } from '../types'
import { easingList } from '../motion/phase'
import { listPaths } from '../motion/paths'

export interface GuiHandle {
  pane: Pane
  destroy: () => void
}

export interface GuiCallbacks {
  onChange?: () => void
  onCopyConfig?: () => void
  onReloadAnalysis?: () => void
  onStartRecord?: () => void
  onPrintRenderCli?: () => void
}

// Feel presets bulk-apply duration/easing feel without touching per-binding bodies.
// Each preset describes a durationScale and a globalEasing override.
const FEEL_PRESETS: Record<Exclude<FeelPreset, 'custom'>, { durationScale: number; globalEasing: EasingName | 'auto' }> = {
  default: { durationScale: 1.0,  globalEasing: 'auto' },
  snappy:  { durationScale: 0.55, globalEasing: 'easeOutCubic' },
  smooth:  { durationScale: 1.4,  globalEasing: 'easeInOutCubic' },
  punchy:  { durationScale: 0.75, globalEasing: 'easeOutExpo' },
  glacial: { durationScale: 2.6,  globalEasing: 'easeInOutQuart' },
  bouncy:  { durationScale: 1.1,  globalEasing: 'easeOutBack' },
}

function applyPreset(config: Config, preset: FeelPreset): void {
  if (preset === 'custom') return
  const p = FEEL_PRESETS[preset]
  config.feel.durationScale = p.durationScale
  config.feel.globalEasing = p.globalEasing
}

function easingOptions(): Record<string, string> {
  const opts: Record<string, string> = { auto: 'auto' }
  for (const name of easingList()) opts[name] = name
  return opts
}

function pathOptions(): Record<string, string> {
  const opts: Record<string, string> = {}
  for (const name of listPaths()) opts[name] = name
  return opts
}

export function mountGui(container: HTMLElement, config: Config, cb: GuiCallbacks): GuiHandle {
  const pane = new Pane({ container, title: 'scenicsynths', expanded: true })
  const change = () => cb.onChange?.()

  // --- Feel (grouped controls) ---
  const fFeel = pane.addFolder({ title: 'feel', expanded: true })
  fFeel.addBinding(config.feel, 'preset', {
    options: {
      custom:  'custom',
      default: 'default',
      snappy:  'snappy',
      smooth:  'smooth',
      punchy:  'punchy',
      glacial: 'glacial',
      bouncy:  'bouncy',
    },
  }).on('change', (e) => {
    const v = e.value as FeelPreset
    if (v !== 'custom') {
      applyPreset(config, v)
      pane.refresh()
    }
    change()
  })
  // Horizontal motion scale — multiplies every dx + tracking + perGlyph.dx globally. Sits right below preset.
  fFeel.addBinding(config.feel, 'horizontalScale', { min: 0, max: 4, step: 0.01, label: 'horizontal ×' }).on('change', change)
  // Row velocity curve — U shape by default: center at 1×, both ends at `edgeScale`×.
  fFeel.addBinding(config.feel, 'rowVelocityShape', {
    label: 'row vel curve',
    options: { flat: 'flat', u: 'u', 'inverted-u': 'inverted-u', linear: 'linear' },
  }).on('change', change)
  fFeel.addBinding(config.feel, 'rowVelocityEdgeScale', { min: 0.25, max: 4, step: 0.05, label: 'edge ×' }).on('change', change)
  const dsBinding = fFeel.addBinding(config.feel, 'durationScale', { min: 0.1, max: 3, step: 0.01 })
  dsBinding.on('change', () => { config.feel.preset = 'custom'; change() })
  const geBinding = fFeel.addBinding(config.feel, 'globalEasing', { options: easingOptions() })
  geBinding.on('change', () => { config.feel.preset = 'custom'; change() })

  // Cubic bezier editor: 4 numeric inputs that compose into {bezier: [...]} applied as the globalEasing.
  const bezierProxy = { x1: 0.33, y1: 0.0, x2: 0.33, y2: 1.0 }
  const fBez = fFeel.addFolder({ title: 'cubic-bezier override', expanded: false })
  fBez.addBinding(bezierProxy, 'x1', { min: 0, max: 1, step: 0.01 })
  fBez.addBinding(bezierProxy, 'y1', { min: -0.5, max: 1.5, step: 0.01 })
  fBez.addBinding(bezierProxy, 'x2', { min: 0, max: 1, step: 0.01 })
  fBez.addBinding(bezierProxy, 'y2', { min: -0.5, max: 1.5, step: 0.01 })
  fBez.addButton({ title: 'apply bezier as global easing' }).on('click', () => {
    config.feel.globalEasing = { bezier: [bezierProxy.x1, bezierProxy.y1, bezierProxy.x2, bezierProxy.y2] } as unknown as EasingName
    config.feel.preset = 'custom'
    change()
  })

  // --- Layout ---
  const fLayout = pane.addFolder({ title: 'layout' })
  fLayout.addBinding(config.layout, 'fontSizePx', { min: 12, max: 220, step: 1 }).on('change', change)
  fLayout.addBinding(config.layout, 'leadingPx', { min: 0, max: 220, step: 1 }).on('change', change)
  fLayout.addBinding(config.layout, 'rotationDeg', { min: -45, max: 45, step: 0.1 }).on('change', change)
  fLayout.addBinding(config.layout, 'rowStaggerPx', { min: 0, max: 1, step: 0.01 }).on('change', change)
  fLayout.addBinding(config.layout, 'marginPx', { min: 0, max: 240, step: 1 }).on('change', change)
  fLayout.addBinding(config.canvas, 'renderScale', { min: 1, max: 4, step: 1, label: 'renderScale (live)' }).on('change', change)

  const fColors = pane.addFolder({ title: 'colors' })
  fColors.addBinding(config.colors, 'background').on('change', change)
  fColors.addBinding(config.colors, 'dim').on('change', change)
  fColors.addBinding(config.colors, 'key').on('change', change)

  // --- Spotlight ---
  const fKey = pane.addFolder({ title: 'spotlight' })
  fKey.addBinding(config.key, 'rows', {
    options: { all: 'all', even: 'even', odd: 'odd', single: 'single' },
  }).on('change', change)
  fKey.addBinding(config.key, 'frequency', { min: 1, max: 50, step: 1 }).on('change', change)
  fKey.addBinding(config.key, 'offsetUnits', { min: -50, max: 50, step: 1 }).on('change', change)
  fKey.addBinding(config.key, 'rowPhaseOffset').on('change', change)
  fKey.addBinding(config.key, 'mode', {
    options: { travels: 'travels', anchored: 'anchored' },
  }).on('change', change)
  fKey.addBinding(config.key, 'anchorScreenOffsetPx', { min: -1000, max: 1000, step: 1 }).on('change', change)
  const rowProxy = { singleRow: typeof config.key.singleRow === 'number' ? String(config.key.singleRow) : 'middle' }
  fKey.addBinding(rowProxy, 'singleRow').on('change', (e) => {
    const v = String(e.value).trim()
    if (v === 'middle') config.key.singleRow = 'middle'
    else {
      const n = Number(v)
      config.key.singleRow = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 'middle'
    }
    change()
  })

  const fText = pane.addFolder({ title: 'text' })
  fText.addBinding(config.text, 'case', {
    options: { lower: 'lower', upper: 'upper', 'as-is': 'as-is' },
  }).on('change', change)

  // --- Band thresholds ---
  const fBands = pane.addFolder({ title: 'band thresholds' })
  for (const b of Object.keys(config.bandThresholds) as Band[]) {
    fBands.addBinding(config.bandThresholds, b, { min: 0, max: 1, step: 0.01 }).on('change', change)
  }

  // --- Tickers ---
  const fTickers = pane.addFolder({ title: 'tickers', expanded: false })
  for (const t of config.tickers) {
    const sub = fTickers.addFolder({ title: t.id, expanded: false })
    sub.addBinding(t, 'modulo', { min: 1, max: 32, step: 1 }).on('change', change)
    sub.addBinding(t, 'band', { options: { kick: 'kick', snare: 'snare', mid: 'mid', hats: 'hats' } }).on('change', change)
    const stProxy = {
      strengthThreshold: t.strengthThreshold ?? 0,
      step: t.step ?? 1,
      stepOffset: t.stepOffset ?? 0,
      offset: t.offset ?? 0,
    }
    sub.addBinding(stProxy, 'strengthThreshold', { min: 0, max: 1, step: 0.01 }).on('change', (e) => { t.strengthThreshold = Number(e.value); change() })
    sub.addBinding(stProxy, 'step',       { min: 1, max: 32, step: 1 }).on('change', (e) => { t.step = Number(e.value); change() })
    sub.addBinding(stProxy, 'stepOffset', { min: 0, max: 32, step: 1 }).on('change', (e) => { t.stepOffset = Number(e.value); change() })
    sub.addBinding(stProxy, 'offset',     { min: -16, max: 16, step: 1 }).on('change', (e) => { t.offset = Number(e.value); change() })
  }

  // --- Bindings (per-phase editing) ---
  const fBindings = pane.addFolder({ title: 'bindings', expanded: false })
  config.bindings.forEach((b, idx) => {
    const target = b.target ?? 'rows'
    const label = `${idx}: ${b.tickerId} → ${target}`
    const sub = fBindings.addFolder({ title: label, expanded: false })
    b.sequence.actions.forEach((a, i) => {
      const row = sub.addFolder({ title: `phase ${i}: ${a.path}`, expanded: false })
      row.addBinding(a, 'path', { options: pathOptions() }).on('change', change)
      row.addBinding(a, 'duration', { min: 0.01, max: 4, step: 0.01 }).on('change', change)
      // easing: present a dropdown; bezier override lives in the Feel folder.
      const easingProxy = { easing: (typeof a.easing === 'string' ? a.easing : 'linear') as EasingName }
      row.addBinding(easingProxy, 'easing', { options: easingOptions() }).on('change', (e) => {
        a.easing = e.value as EasingName
        change()
      })
    })
  })

  // --- Camera baseline + overshoot ---
  const fCam = pane.addFolder({ title: 'camera baseline', expanded: false })
  fCam.addBinding(config.camera.baseline, 'zoom', { min: 0.1, max: 4, step: 0.01 }).on('change', change)
  fCam.addBinding(config.camera.baseline, 'panX', { min: -2000, max: 2000, step: 1 }).on('change', change)
  fCam.addBinding(config.camera.baseline, 'panY', { min: -2000, max: 2000, step: 1 }).on('change', change)
  fCam.addBinding(config.camera.baseline, 'tilt', { min: -180, max: 180, step: 0.1 }).on('change', change)
  fCam.addBinding(config.camera, 'rowOvershoot', { min: 0, max: 10, step: 1 }).on('change', change)

  // --- Record ---
  const fRec = pane.addFolder({ title: 'record', expanded: true })
  fRec.addBinding(config.record, 'startAt', { min: 0, max: 600, step: 0.1, label: 'start (s)' }).on('change', change)
  fRec.addBinding(config.record, 'duration', { min: 0.5, max: 300, step: 0.5, label: 'duration (s)' }).on('change', change)
  fRec.addBinding(config.record, 'fps', { options: { '24': 24, '30': 30, '60': 60 } }).on('change', change)
  fRec.addBinding(config.record, 'videoBitrateMbps', { min: 2, max: 80, step: 1, label: 'bitrate (Mbps)' }).on('change', change)
  fRec.addBinding(config.record, 'resolutionMultiplier', { min: 1, max: 4, step: 1, label: 'res ×' }).on('change', change)
  fRec.addBinding(config.record, 'engine', {
    label: 'engine',
    options: { auto: 'auto', webcodecs: 'webcodecs (mp4)', mediarecorder: 'mediarecorder (webm)' },
  }).on('change', change)
  fRec.addBinding(config.record, 'renderSlowdown', { min: 1, max: 10, step: 1, label: 'slowdown (fallback)' }).on('change', change)
  fRec.addButton({ title: 'RECORD webm (in-browser)' }).on('click', () => cb.onStartRecord?.())
  fRec.addButton({ title: 'copy MP4 render CLI' }).on('click', () => cb.onPrintRenderCli?.())

  // --- Debug ---
  const fDebug = pane.addFolder({ title: 'debug' })
  fDebug.addBinding(config.debug, 'hud').on('change', change)
  fDebug.addButton({ title: 'copy config JSON' }).on('click', () => cb.onCopyConfig?.())
  fDebug.addButton({ title: 'reload analysis' }).on('click', () => cb.onReloadAnalysis?.())

  return {
    pane,
    destroy: () => pane.dispose(),
  }
}
