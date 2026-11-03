import { describe, it, expect } from 'vitest'
import { JsonEventSource } from '../src/audio/eventSource'
import { evaluate } from '../src/engine'
import { DEFAULT_CONFIG } from '../src/config/defaults'
import type { AnalysisData, Config, RowMotionState } from '../src/types'
import type { UnitLayout } from '../src/text/layout'

const fakeLayout: UnitLayout = {
  unit: 'scenicsynth',
  unitLength: 11,
  stride: 100,
  unitPos: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].slice(0, 11),
  ascent: 50,
  descent: 10,
  lineHeight: 60,
  xHeight: 25,
  capHeight: 35,
  size: 72,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: {} as any,
}

function makeSource(kick: { t: number; strength: number }[]): JsonEventSource {
  const data: AnalysisData = {
    track: 'test',
    bpm: 120,
    duration: 20,
    sampleRate: 44100,
    beats: [],
    downbeats: [],
    bands: { kick, snare: [], mid: [], hats: [] },
  }
  return new JsonEventSource(data)
}

function slideStepConfig(respectAlternation: boolean): Config {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.tickers = [{ id: 'k', band: 'kick', modulo: 1 }]
  cfg.bindings = [
    {
      tickerId: 'k',
      rows: 'all',
      compose: 'add',
      respectAlternation,
      sequence: {
        actions: [
          { path: 'slideStep', params: { units: 1 }, duration: 0.25, easing: 'easeOutCubic' },
        ],
      },
    },
  ]
  cfg.bandThresholds = { kick: 0, snare: 0, mid: 0, hats: 0 }
  // Isolate the alternation invariant from the row velocity curve added for the U-shaped speed feature.
  cfg.feel.rowVelocityShape = 'flat'
  return cfg
}

function pickScalars(r: RowMotionState) {
  return { dx: r.dx, dy: r.dy, scale: r.scale, rotation: r.rotation, opacity: r.opacity, tracking: r.tracking }
}

describe('determinism', () => {
  it('three calls at the same t with same inputs produce structurally equal rows', () => {
    const cfg = slideStepConfig(true)
    const source = makeSource([
      { t: 0, strength: 1 },
      { t: 0.5, strength: 1 },
      { t: 1.1, strength: 1 },
    ])
    const t = 1.2
    const s1 = evaluate({ t, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    const s2 = evaluate({ t, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    const s3 = evaluate({ t, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    expect(s1.rows.map(pickScalars)).toEqual(s2.rows.map(pickScalars))
    expect(s2.rows.map(pickScalars)).toEqual(s3.rows.map(pickScalars))
  })

  it('no mutation leaks between calls: evaluating at t=1.5 directly === after prior calls at other t', () => {
    const cfg = slideStepConfig(true)
    const source = makeSource([
      { t: 0, strength: 1 },
      { t: 0.5, strength: 1 },
      { t: 1.1, strength: 1 },
    ])
    const direct = evaluate({ t: 1.5, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    // Walk through t=0.1, 0.8, then evaluate at 1.5.
    evaluate({ t: 0.1, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    evaluate({ t: 0.8, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    const afterWalk = evaluate({ t: 1.5, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    expect(direct.rows.map(pickScalars)).toEqual(afterWalk.rows.map(pickScalars))
  })
})

describe('row velocity U-curve', () => {
  it("'u' shape with edge 2 scales row 0 and row 4 by 2x, row 2 (center) by 1x, for rowCount 5", () => {
    const cfg = slideStepConfig(false)
    cfg.feel.rowVelocityShape = 'u'
    cfg.feel.rowVelocityEdgeScale = 2
    const source = makeSource([{ t: 0, strength: 1 }])
    const state = evaluate({ t: 0.25, config: cfg, source, layout: fakeLayout, rowCount: 5, keyRow: 2 })
    // p = i/(n-1): [0, 0.25, 0.5, 0.75, 1]. scale = 1 + (edge-1)*(2p-1)^2
    expect(state.rows[0].dx).toBeCloseTo(200, 2)   // 2x
    expect(state.rows[1].dx).toBeCloseTo(125, 2)   // 1.25x
    expect(state.rows[2].dx).toBeCloseTo(100, 2)   // 1x
    expect(state.rows[3].dx).toBeCloseTo(125, 2)
    expect(state.rows[4].dx).toBeCloseTo(200, 2)
  })

  it("'flat' shape leaves rows at 1x regardless of edge value", () => {
    const cfg = slideStepConfig(false)
    cfg.feel.rowVelocityShape = 'flat'
    cfg.feel.rowVelocityEdgeScale = 3
    const source = makeSource([{ t: 0, strength: 1 }])
    const state = evaluate({ t: 0.25, config: cfg, source, layout: fakeLayout, rowCount: 5, keyRow: 2 })
    for (const r of state.rows) expect(r.dx).toBeCloseTo(100, 2)
  })
})

describe('alternation invariant', () => {
  it('respectAlternation: true -> row 0 +unitWidth, row 1 -unitWidth, row 2 +unitWidth', () => {
    const cfg = slideStepConfig(true)
    const source = makeSource([{ t: 0, strength: 1 }])
    // duration=0.25 ensures t=0.25 is fully settled.
    const state = evaluate({ t: 0.25, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    expect(state.rows[0].dx).toBeCloseTo(+100, 2)
    expect(state.rows[1].dx).toBeCloseTo(-100, 2)
    expect(state.rows[2].dx).toBeCloseTo(+100, 2)
    expect(state.rows[3].dx).toBeCloseTo(-100, 2)
  })

  it('respectAlternation: false -> all rows share the same sign', () => {
    const cfg = slideStepConfig(false)
    const source = makeSource([{ t: 0, strength: 1 }])
    const state = evaluate({ t: 0.25, config: cfg, source, layout: fakeLayout, rowCount: 4, keyRow: 2 })
    expect(state.rows[0].dx).toBeCloseTo(+100, 2)
    expect(state.rows[1].dx).toBeCloseTo(+100, 2)
    expect(state.rows[2].dx).toBeCloseTo(+100, 2)
    expect(state.rows[3].dx).toBeCloseTo(+100, 2)
  })
})
