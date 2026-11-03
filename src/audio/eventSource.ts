import type { AnalysisData, Band, TransientEvent } from '../types'

export interface EventSource {
  readonly bpm: number
  readonly duration: number
  readonly bands: readonly Band[]
  /** All events for a band, sorted by time ascending. */
  getEvents(band: Band): TransientEvent[]
  /** Number of events in a band at or before `t` with strength >= threshold. O(log n). */
  countBefore(band: Band, t: number, threshold: number): number
  /** The i-th event in a band after filtering by threshold. Returns null if out of range. */
  eventAtIndex(band: Band, index: number, threshold: number): TransientEvent | null
  /** The last event in a band at or before `t` with strength >= threshold. */
  lastBefore(band: Band, t: number, threshold: number): TransientEvent | null
  /** Beats at or before `t`. */
  beatsBefore(t: number): number
  /** Downbeats at or before `t`. */
  downbeatsBefore(t: number): number
}

// Future: live event source. Interface intentionally left here as a reminder.
export interface LiveEventSource extends EventSource {
  start(): Promise<void>
  stop(): void
}

// Precomputed, threshold-independent lookup helpers.
// We store sorted events plus a precomputed prefix array of strengths so filtering by a dynamic
// threshold is still O(log n + k) where k is the small number of events skipped.
// Simplicity > exotic data structures: linear scan from a binary-search anchor is fine for the event rates
// we expect (hundreds to a few thousand per band).

function binarySearchT(events: TransientEvent[], t: number): number {
  // Returns the number of events with event.t <= t. (Rightmost insertion point.)
  let lo = 0, hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid].t <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class JsonEventSource implements EventSource {
  readonly bpm: number
  readonly duration: number
  readonly bands: readonly Band[]
  private readonly data: AnalysisData

  constructor(data: AnalysisData) {
    this.data = data
    this.bpm = data.bpm
    this.duration = data.duration
    this.bands = Object.keys(data.bands) as Band[]
  }

  static async load(url: string): Promise<JsonEventSource> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to load analysis JSON: ${url} (${res.status})`)
    const data = (await res.json()) as AnalysisData
    // Defensive: ensure each band is sorted by t and strengths clamped.
    for (const band of Object.keys(data.bands) as Band[]) {
      const arr = data.bands[band]
      arr.sort((a, b) => a.t - b.t)
      for (const e of arr) e.strength = Math.max(0, Math.min(1, e.strength))
    }
    data.beats = (data.beats ?? []).slice().sort((a, b) => a - b)
    data.downbeats = (data.downbeats ?? []).slice().sort((a, b) => a - b)
    return new JsonEventSource(data)
  }

  getEvents(band: Band): TransientEvent[] {
    return this.data.bands[band] ?? []
  }

  countBefore(band: Band, t: number, threshold: number): number {
    const arr = this.getEvents(band)
    const upto = binarySearchT(arr, t)
    if (threshold <= 0) return upto
    let n = 0
    for (let i = 0; i < upto; i++) if (arr[i].strength >= threshold) n++
    return n
  }

  eventAtIndex(band: Band, index: number, threshold: number): TransientEvent | null {
    const arr = this.getEvents(band)
    if (threshold <= 0) return arr[index] ?? null
    let seen = 0
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].strength >= threshold) {
        if (seen === index) return arr[i]
        seen++
      }
    }
    return null
  }

  lastBefore(band: Band, t: number, threshold: number): TransientEvent | null {
    const arr = this.getEvents(band)
    const upto = binarySearchT(arr, t)
    for (let i = upto - 1; i >= 0; i--) {
      if (arr[i].strength >= threshold) return arr[i]
    }
    return null
  }

  beatsBefore(t: number): number {
    return binarySearchT(this.data.beats.map((bt) => ({ t: bt, strength: 1 })), t)
  }

  downbeatsBefore(t: number): number {
    return binarySearchT(this.data.downbeats.map((bt) => ({ t: bt, strength: 1 })), t)
  }

  rawBeats(): number[] { return this.data.beats }
  rawDownbeats(): number[] { return this.data.downbeats }
}

// A trivial stand-in for when no analysis JSON is loaded yet. Emits uniform kicks at 2 Hz so
// motion can be developed in isolation.
export class SyntheticEventSource implements EventSource {
  readonly bpm = 120
  readonly duration = 600
  readonly bands: readonly Band[] = ['kick', 'snare', 'mid', 'hats']

  private events: Record<Band, TransientEvent[]>

  constructor() {
    const kick: TransientEvent[] = []
    const snare: TransientEvent[] = []
    const hats: TransientEvent[] = []
    const mid: TransientEvent[] = []
    const beatInterval = 60 / this.bpm       // 0.5s at 120 BPM
    const steps = Math.floor(this.duration / beatInterval)
    for (let i = 0; i < steps; i++) {
      const t = i * beatInterval
      kick.push({ t, strength: 1 })
      if (i % 2 === 1) snare.push({ t, strength: 1 })
      // Hats on 8ths.
      hats.push({ t, strength: 0.6 })
      hats.push({ t: t + beatInterval / 2, strength: 0.4 })
      // Mid sparse.
      if (i % 4 === 0) mid.push({ t, strength: 0.5 })
    }
    this.events = { kick, snare, mid, hats }
  }

  getEvents(band: Band): TransientEvent[] { return this.events[band] }
  countBefore(band: Band, t: number, threshold: number): number {
    const arr = this.events[band]
    const upto = binarySearchT(arr, t)
    if (threshold <= 0) return upto
    let n = 0
    for (let i = 0; i < upto; i++) if (arr[i].strength >= threshold) n++
    return n
  }
  eventAtIndex(band: Band, index: number, threshold: number): TransientEvent | null {
    const arr = this.events[band]
    if (threshold <= 0) return arr[index] ?? null
    let seen = 0
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].strength >= threshold) { if (seen === index) return arr[i]; seen++ }
    }
    return null
  }
  lastBefore(band: Band, t: number, threshold: number): TransientEvent | null {
    const arr = this.events[band]
    const upto = binarySearchT(arr, t)
    for (let i = upto - 1; i >= 0; i--) {
      if (arr[i].strength >= threshold) return arr[i]
    }
    return null
  }
  beatsBefore(t: number): number {
    const beatInterval = 60 / this.bpm
    return Math.max(0, Math.floor(t / beatInterval) + 1)
  }
  downbeatsBefore(t: number): number {
    const beatInterval = 60 / this.bpm
    return Math.max(0, Math.floor(t / (beatInterval * 4)) + 1)
  }
}
