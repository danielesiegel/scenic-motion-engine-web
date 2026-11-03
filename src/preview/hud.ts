import type { FrameState } from '../types'
import type { EventSource } from '../audio/eventSource'

export function renderHud(el: HTMLElement, state: FrameState, source: EventSource): void {
  const beats = source.beatsBefore(state.t)
  const bars = source.downbeatsBefore(state.t)
  const bpm = source.bpm.toFixed(2)
  const lines: string[] = []
  lines.push(`t = ${state.t.toFixed(3)}s  bpm = ${bpm}  beat# = ${beats}  bar# = ${bars}`)
  lines.push('')
  for (const tk of state.tickers) {
    const flash = tk.sinceLast < 0.08 ? '●' : ' '
    const pathName = tk.activeAction?.path ?? '—'
    lines.push(
      `${flash} ${tk.id.padEnd(14)} band=${tk.band.padEnd(5)} count=${String(tk.count).padEnd(4)} phase=${tk.phase} ` +
        `prog=${tk.progress.toFixed(2)} str=${tk.strength.toFixed(2)} path=${pathName}`,
    )
  }
  el.textContent = lines.join('\n')
}
