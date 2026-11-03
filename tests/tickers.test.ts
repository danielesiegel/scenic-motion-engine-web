import { describe, it, expect } from 'vitest'
import { JsonEventSource } from '../src/audio/eventSource'
import type { AnalysisData } from '../src/types'

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

describe('JsonEventSource.countBefore', () => {
  it('returns 0 before any event and increments as t crosses each event', () => {
    const src = makeSource([
      { t: 0, strength: 1 },
      { t: 1, strength: 1 },
      { t: 2, strength: 1 },
    ])
    expect(src.countBefore('kick', -0.1, 0)).toBe(0)
    expect(src.countBefore('kick', 0, 0)).toBe(1)
    expect(src.countBefore('kick', 0.5, 0)).toBe(1)
    expect(src.countBefore('kick', 1, 0)).toBe(2)
    expect(src.countBefore('kick', 1.999, 0)).toBe(2)
    expect(src.countBefore('kick', 2, 0)).toBe(3)
    expect(src.countBefore('kick', 100, 0)).toBe(3)
  })

  it('threshold filtering excludes weak events', () => {
    const src = makeSource([
      { t: 0, strength: 0.3 },
      { t: 1, strength: 0.8 },
      { t: 2, strength: 0.3 },
      { t: 3, strength: 0.9 },
    ])
    // threshold 0: counts everything
    expect(src.countBefore('kick', 10, 0)).toBe(4)
    // threshold 0.5: excludes the 0.3-strength events
    expect(src.countBefore('kick', 10, 0.5)).toBe(2)
    expect(src.countBefore('kick', 1, 0.5)).toBe(1)
    expect(src.countBefore('kick', 2, 0.5)).toBe(1) // 0.3 at t=2 filtered out
    expect(src.countBefore('kick', 3, 0.5)).toBe(2)
  })

  it('eventAtIndex respects threshold filtering', () => {
    const src = makeSource([
      { t: 0, strength: 0.3 },
      { t: 1, strength: 0.8 },
      { t: 2, strength: 0.3 },
      { t: 3, strength: 0.9 },
    ])
    expect(src.eventAtIndex('kick', 0, 0.5)?.t).toBe(1)
    expect(src.eventAtIndex('kick', 1, 0.5)?.t).toBe(3)
    expect(src.eventAtIndex('kick', 2, 0.5)).toBeNull()
  })
})

describe('ticker phase cycling: (count + offset) % modulo', () => {
  it('with modulo=4 and 10 events, phase_at(event_i + eps) === (i + offset) % 4', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ t: i, strength: 1 }))
    const src = makeSource(events)
    const modulo = 4
    const offset = 0
    const eps = 1e-6
    for (let i = 0; i < events.length; i++) {
      const t = events[i].t + eps
      const count = src.countBefore('kick', t, 0)
      // The "latest event" is index count-1, whose phase is (latestIdx + offset) % modulo.
      const latestIdx = count - 1
      const phase = ((latestIdx + offset) % modulo + modulo) % modulo
      expect(count).toBe(i + 1)
      expect(phase).toBe(i % 4)
    }
  })

  it('non-zero offset shifts the phase', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ t: i, strength: 1 }))
    const src = makeSource(events)
    const modulo = 4
    const offset = 2
    for (let i = 0; i < events.length; i++) {
      const t = events[i].t + 1e-6
      const latestIdx = src.countBefore('kick', t, 0) - 1
      const phase = ((latestIdx + offset) % modulo + modulo) % modulo
      expect(phase).toBe((i + 2) % 4)
    }
  })

  it('threshold-filtered events renumber the phase sequence', () => {
    const src = makeSource([
      { t: 0, strength: 0.3 }, // filtered
      { t: 1, strength: 1 },   // index 0 after filter
      { t: 2, strength: 0.2 }, // filtered
      { t: 3, strength: 1 },   // index 1 after filter
      { t: 4, strength: 1 },   // index 2 after filter
    ])
    const modulo = 2
    const threshold = 0.5
    const atT = (t: number) => {
      const count = src.countBefore('kick', t, threshold)
      const latestIdx = count - 1
      return latestIdx < 0 ? -1 : (latestIdx % modulo + modulo) % modulo
    }
    expect(atT(0.5)).toBe(-1) // only weak event seen
    expect(atT(1.5)).toBe(0)
    expect(atT(2.5)).toBe(0) // weak event doesn't advance phase
    expect(atT(3.5)).toBe(1)
    expect(atT(4.5)).toBe(0)
  })
})
