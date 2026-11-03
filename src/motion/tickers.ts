import type { EventSource } from '../audio/eventSource'
import type { Band, PhaseSequence, TickerConfig, TransientEvent } from '../types'

// A ticker computes its phase from events of a band seen so far.
// phase(n) = (n + offset) mod modulo, where n is the number of qualifying events at or before t.
// The active action is sequence.actions[phase(n-1)] (phase of the LATEST event).
// All methods here are pure functions of (t, config, source, threshold).

export interface TickerResolved {
  config: TickerConfig
  band: Band
  modulo: number
  offset: number
  effectiveThreshold: number
}

export function resolveThreshold(config: TickerConfig, runtimeThresholds: Record<Band, number>): number {
  return Math.max(config.strengthThreshold ?? 0, runtimeThresholds[config.band] ?? 0)
}

export interface TickerFrame {
  count: number                 // # qualifying events at or before t
  phaseOfLatest: number         // phase index selected by the most recent event (0 if no events)
  latestEvent: TransientEvent | null
  sinceLast: number             // t - latestEvent.t, Infinity if none
  activeDuration: number        // duration of the active action
  progress: number              // 0..1 within the active action
}

export function evaluateTicker(
  t: number,
  resolved: TickerResolved,
  sequence: PhaseSequence,
  source: EventSource,
): TickerFrame {
  const { band, modulo, offset, effectiveThreshold } = resolved
  const count = source.countBefore(band, t, effectiveThreshold)
  if (count === 0 || sequence.actions.length === 0) {
    return { count: 0, phaseOfLatest: offset % modulo, latestEvent: null, sinceLast: Infinity, activeDuration: 0, progress: 0 }
  }
  const latestIdx = count - 1
  const latestEvent = source.eventAtIndex(band, latestIdx, effectiveThreshold)
  const phaseOfLatest = ((latestIdx + offset) % modulo + modulo) % modulo
  const activeAction = sequence.actions[phaseOfLatest % sequence.actions.length]
  const sinceLast = latestEvent ? t - latestEvent.t : Infinity
  const activeDuration = Math.max(1e-6, activeAction.duration)
  const progress = Math.max(0, Math.min(1, sinceLast / activeDuration))
  return { count, phaseOfLatest, latestEvent, sinceLast, activeDuration, progress }
}
