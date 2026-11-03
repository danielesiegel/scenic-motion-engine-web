import { describe, it, expect } from 'vitest'
import { JsonEventSource } from '../src/audio/eventSource'
import { evaluate } from '../src/engine'
import { DEFAULT_CONFIG } from '../src/config/defaults'
import type { AnalysisData, Config } from '../src/types'
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

function baseConfig(): Config {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.tickers = []
  cfg.bindings = []
  cfg.bandThresholds = { kick: 0, snare: 0, mid: 0, hats: 0 }
  return cfg
}

describe('continuity across phase changes', () => {
  // Ticker with 2 phases:
  //   phase 0: slideStep (duration 0.5s, units=1, settles to +100 at unitWidth=100)
  //   phase 1: reverseNudge (duration 0.5s, units=0.5, settles to -50)
  // Events at t = 0, 1, 2. Only row 0 (dir=+1), no alternation to keep math simple.
  function configTwoPhase(): Config {
    const cfg = baseConfig()
    cfg.tickers = [{ id: 'k', band: 'kick', modulo: 2 }]
    cfg.bindings = [
      {
        tickerId: 'k',
        rows: [0],
        compose: 'add',
        respectAlternation: false,
        sequence: {
          actions: [
            { path: 'slideStep', params: { units: 1 }, duration: 0.5, easing: 'easeOutCubic' },
            { path: 'reverseNudge', params: { units: 0.5 }, duration: 0.5, easing: 'easeOutCubic' },
          ],
        },
      },
    ]
    return cfg
  }

  const source = makeSource([
    { t: 0, strength: 1 },
    { t: 1, strength: 1 },
    { t: 2, strength: 1 },
  ])

  it('settles to +100 at end of first action (t=0.5)', () => {
    const state = evaluate({ t: 0.5, config: configTwoPhase(), source, layout: fakeLayout, rowCount: 1, keyRow: 0 })
    expect(state.rows[0].dx).toBeCloseTo(100, 2)
  })

  it('continuity: at t=1.0 the new action contributes 0, prior frozen contribution is +100', () => {
    const state = evaluate({ t: 1.0, config: configTwoPhase(), source, layout: fakeLayout, rowCount: 1, keyRow: 0 })
    expect(state.rows[0].dx).toBeCloseTo(100, 2)
  })

  it('at t=1.5 the second (reverse) action is fully settled: +100 - 50 = +50', () => {
    const state = evaluate({ t: 1.5, config: configTwoPhase(), source, layout: fakeLayout, rowCount: 1, keyRow: 0 })
    expect(state.rows[0].dx).toBeCloseTo(50, 2)
  })

  // Truncation: single-phase slideStep (duration 0.5s, +100), events at t=0 and t=0.25.
  // The first event's action is cut off at t=0.25 => frozenProgress = 0.25/0.5 = 0.5
  // => easeOutCubic(0.5) = 1 - (1-0.5)^3 = 0.875 => dx contribution = 87.5
  // The second event just fired => progress=0 => dx=0. Total = 87.5.
  it('truncation freezes the prior action at (gap / duration) progress with easing applied', () => {
    const cfg = baseConfig()
    cfg.tickers = [{ id: 'k', band: 'kick', modulo: 1 }]
    cfg.bindings = [
      {
        tickerId: 'k',
        rows: [0],
        compose: 'add',
        respectAlternation: false,
        sequence: {
          actions: [
            { path: 'slideStep', params: { units: 1 }, duration: 0.5, easing: 'easeOutCubic' },
          ],
        },
      },
    ]
    const src = makeSource([
      { t: 0, strength: 1 },
      { t: 0.25, strength: 1 },
    ])
    const state = evaluate({ t: 0.25, config: cfg, source: src, layout: fakeLayout, rowCount: 1, keyRow: 0 })
    expect(state.rows[0].dx).toBeCloseTo(87.5, 1)
  })
})
