import { DEFAULT_CONFIG } from './config/defaults'
import type { Config } from './types'
import { loadFont } from './text/font'
import { buildUnitLayout } from './text/layout'
import { JsonEventSource, SyntheticEventSource } from './audio/eventSource'
import type { EventSource } from './audio/eventSource'
import { evaluate } from './engine'
import {
  computeAutoRowCount,
  computeRowLineHeight,
  keyRowFromConfig,
  render,
} from './render/canvas'
import { Player } from './preview/player'
import { renderHud } from './preview/hud'
import { mountGui } from './preview/gui'
import { recordWebm, downloadBlob, buildRenderCliCommand } from './preview/recorder'
import { recordMp4, webCodecsAvailable } from './preview/webcodecsRecorder'

async function discoverAudio(): Promise<{ audioUrl: string | null; analysisUrl: string | null; track: string | null }> {
  // Convention: assets/audio/<track>.wav and analysis/<track>.json. Vite's dev server returns index.html
  // (status 200, content-type text/html) for missing static paths — probe with a Range GET and sniff the
  // leading bytes for a WAV header (RIFF....WAVE) rather than trusting status alone.
  const candidates = ['kafkaesque', 'scenicsynths', 'track', 'song', 'input']
  for (const name of candidates) {
    const audioUrl = `/assets/audio/${name}.wav`
    const analysisUrl = `/analysis/${name}.json`
    try {
      const res = await fetch(audioUrl, { headers: { Range: 'bytes=0-15' } })
      if (!res.ok) continue
      const buf = await res.arrayBuffer()
      if (buf.byteLength < 12) continue
      const v = new DataView(buf)
      const riff = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))
      const wave = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11))
      if (riff === 'RIFF' && wave === 'WAVE') {
        return { audioUrl, analysisUrl, track: name }
      }
    } catch { /* ignore */ }
  }
  return { audioUrl: null, analysisUrl: null, track: null }
}

async function loadEventSource(analysisUrl: string | null): Promise<EventSource> {
  if (!analysisUrl) return new SyntheticEventSource()
  try {
    return await JsonEventSource.load(analysisUrl)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[scenicsynths] analysis JSON not found at ${analysisUrl} — using synthetic events.`, err)
    return new SyntheticEventSource()
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement
  const hudEl = document.getElementById('hud') as HTMLElement
  const btnPlay = document.getElementById('btn-play') as HTMLButtonElement
  const btnStill = document.getElementById('btn-still') as HTMLButtonElement
  const btnHud = document.getElementById('btn-hud') as HTMLButtonElement
  const scrub = document.getElementById('scrub') as HTMLInputElement
  const timeEl = document.getElementById('time') as HTMLSpanElement
  const stage = document.getElementById('stage') as HTMLElement

  const ctx = canvas.getContext('2d')!
  const config: Config = structuredClone(DEFAULT_CONFIG)
  // Fit canvas to the stage preserving aspect of config.canvas.{width,height}.
  const resize = () => {
    const stageRect = stage.getBoundingClientRect()
    const aspect = config.canvas.width / config.canvas.height
    let w = stageRect.width
    let h = w / aspect
    if (h > stageRect.height) { h = stageRect.height; w = h * aspect }
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const dpr = window.devicePixelRatio || 1
    config.canvas.dpr = dpr
    const rs = Math.max(1, config.canvas.renderScale || 1)
    canvas.width = Math.round(config.canvas.width * dpr * rs)
    canvas.height = Math.round(config.canvas.height * dpr * rs)
  }
  resize()
  window.addEventListener('resize', resize)
  // Re-fit the backing store any time renderScale changes.
  let lastRenderScale = config.canvas.renderScale
  setInterval(() => {
    if (config.canvas.renderScale !== lastRenderScale) {
      lastRenderScale = config.canvas.renderScale
      resize()
    }
  }, 250)

  // Load font + layout + audio in parallel.
  const [loaded, discovered] = await Promise.all([loadFont(), discoverAudio()])
  config.audio.track = discovered.track
  config.audio.analysisUrl = discovered.analysisUrl
  const layout = buildUnitLayout(loaded.font, config.layout.fontSizePx, config.text.unit)
  const source = await loadEventSource(discovered.analysisUrl)

  const player = new Player({ audioUrl: discovered.audioUrl, duration: source.duration })
  try { await player.ready() } catch { /* audio load failed; keep going silently */ }

  // Mount GUI (append to body as side panel).
  const panelHost = document.createElement('div')
  panelHost.id = 'pane'
  document.body.appendChild(panelHost)
  let recording = false
  mountGui(panelHost, config, {
    onChange: () => { /* next rAF already picks up config */ },
    onCopyConfig: () => {
      const json = JSON.stringify(config, null, 2)
      navigator.clipboard?.writeText(json).catch(() => void 0)
      // eslint-disable-next-line no-console
      console.log('[scenicsynths] config:\n' + json)
    },
    onReloadAnalysis: async () => {
      if (!discovered.analysisUrl) return
      try {
        const newSource = await JsonEventSource.load(discovered.analysisUrl + '?t=' + Date.now())
        ;(window as unknown as { __source: EventSource }).__source = newSource
        // eslint-disable-next-line no-console
        console.log('[scenicsynths] analysis reloaded.')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[scenicsynths] reload failed', err)
      }
    },
    onStartRecord: async () => {
      if (recording) { console.warn('[record] already recording'); return }
      recording = true
      timeEl.textContent = 'recording…'

      const prevRenderScale = config.canvas.renderScale
      const mult = Math.max(1, config.record.resolutionMultiplier || 1)
      config.canvas.renderScale = Math.max(prevRenderScale, mult)
      window.dispatchEvent(new Event('resize'))
      await new Promise((r) => setTimeout(r, 60))

      // Decide which engine to use. 'auto' prefers WebCodecs when the browser supports it.
      const engineChoice = config.record.engine
      const useWebCodecs =
        engineChoice === 'webcodecs' ||
        (engineChoice === 'auto' && webCodecsAvailable())

      const track = (discovered.track ?? 'scenicsynths')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        if (useWebCodecs) {
          // Pause the live loop; the recorder drives the canvas frame-by-frame.
          liveLoopControl.pause()
          player.pause()
          const blob = await recordMp4(
            {
              canvas,
              renderFrameAt,
              onLog: (m) => console.log(m),
              onProgress: (sec, total) => { timeEl.textContent = `rec ${sec.toFixed(2)}/${total.toFixed(2)}s (webcodecs)` },
            },
            {
              startAt: config.record.startAt,
              duration: config.record.duration,
              fps: config.record.fps,
              videoBitsPerSecond: config.record.videoBitrateMbps * 1_000_000,
              wallSlowdown: Math.max(0, config.record.renderSlowdown - 1),
            },
          )
          downloadBlob(blob, `${track}_${config.record.startAt}s-${config.record.duration}s_${mult}x_${stamp}.mp4`)
          // Audio is NOT in the MP4 — print the ffmpeg mux command for convenience.
          const audioStart = config.record.startAt
          const audioEnd = config.record.startAt + config.record.duration
          const muxCmd = `ffmpeg -i ${track}_...mp4 -ss ${audioStart} -to ${audioEnd} -i assets/audio/${track}.wav -c:v copy -c:a aac -b:a 192k -shortest ${track}_with_audio.mp4`
          console.log('[record] saved MP4 (video only). To mux original audio:\n' + muxCmd)
          navigator.clipboard?.writeText(muxCmd).catch(() => void 0)
        } else {
          // Fallback: MediaRecorder with optional playbackRate slowdown so wall-clock capture doesn't drop frames.
          const slowdown = Math.max(1, Math.floor(config.record.renderSlowdown || 1))
          const audio = player.audioElement
          const prevRate = audio?.playbackRate ?? 1
          if (audio) audio.playbackRate = 1 / slowdown
          try {
            const blob = await recordWebm(
              { canvas, player, audioEl: audio, onLog: (m) => console.log(m), onProgress: (s) => { timeEl.textContent = `rec ${s.toFixed(2)}/${config.record.duration * slowdown}s (wall) → ${config.record.duration}s engine` } },
              {
                // In mediarecorder mode, wall-time duration = engine duration * slowdown
                startAt: config.record.startAt,
                duration: config.record.duration * slowdown,
                fps: config.record.fps,
                videoBitsPerSecond: config.record.videoBitrateMbps * 1_000_000,
              },
            )
            const suffix = slowdown > 1 ? `_slow${slowdown}x` : ''
            downloadBlob(blob, `${track}_${config.record.startAt}s-${config.record.duration}s_${mult}x${suffix}_${stamp}.webm`)
            if (slowdown > 1) {
              const speedupCmd = `ffmpeg -i IN.webm -filter:v "setpts=PTS/${slowdown}" -an OUT.webm   # then mux original audio with: ffmpeg -i OUT.webm -ss ${config.record.startAt} -to ${config.record.startAt + config.record.duration} -i assets/audio/${track}.wav -c:v copy -c:a aac FINAL.mp4`
              console.log('[record] slow-mo webm saved. Speed up & mux audio with:\n' + speedupCmd)
              navigator.clipboard?.writeText(speedupCmd).catch(() => void 0)
            } else {
              console.log('[record] saved.')
            }
          } finally {
            if (audio) audio.playbackRate = prevRate
          }
        }
      } catch (err) {
        console.error('[record] failed', err)
      } finally {
        liveLoopControl.resume()
        config.canvas.renderScale = prevRenderScale
        window.dispatchEvent(new Event('resize'))
        recording = false
      }
    },
    onPrintRenderCli: () => {
      const cmd = buildRenderCliCommand({
        track: discovered.track,
        startAt: config.record.startAt,
        duration: config.record.duration,
        fps: config.record.fps,
        width: config.canvas.width,
        height: config.canvas.height,
      })
      navigator.clipboard?.writeText(cmd).catch(() => void 0)
      console.log('[render] run this in a shell for an h264 MP4 (needs dev server running):\n' + cmd)
    },
  })

  // The source may be swapped by the reload button, so keep a mutable ref.
  const srcRef: { current: EventSource } = { current: source }
  ;(window as unknown as { __source: EventSource }).__source = source
  Object.defineProperty(window, '__srcRef', { value: srcRef, configurable: true })

  // Transport wiring.
  btnPlay.addEventListener('click', async () => {
    if (player.isPlaying) { player.pause(); btnPlay.textContent = 'play' }
    else { await player.play(); btnPlay.textContent = 'pause' }
  })
  btnStill.addEventListener('click', () => {
    player.pause()
    btnPlay.textContent = 'play'
    player.seek(0)
  })
  btnHud.addEventListener('click', () => {
    config.debug.hud = !config.debug.hud
    hudEl.classList.toggle('on', config.debug.hud)
  })
  scrub.addEventListener('input', () => {
    const t = (Number(scrub.value) / 1000) * player.duration
    player.seek(t)
  })

  // Draw loop. The engine is a pure function of t, so we can call it every rAF.
  // We rebuild the layout only when fontSizePx changes.
  let lastFontSize = config.layout.fontSizePx
  let currentLayout = layout
  // When the recorder owns the canvas, pause the live loop so it doesn't overwrite recorder-drawn frames.
  let liveLoopPaused = false

  const renderFrameAt = (t: number) => {
    if (config.layout.fontSizePx !== lastFontSize) {
      lastFontSize = config.layout.fontSizePx
      currentLayout = buildUnitLayout(loaded.font, config.layout.fontSizePx, config.text.unit)
    }
    const rowCount = config.layout.rows === 'auto' ? computeAutoRowCount(config, currentLayout) : config.layout.rows
    const keyRow = keyRowFromConfig(config, rowCount)
    const srcNow = (window as unknown as { __source: EventSource }).__source
    const state = evaluate({ t, config, source: srcNow, layout: currentLayout, rowCount, keyRow })
    render({ ctx, state, config, layout: currentLayout, rowCount, keyRow })
    return state
  }

  const draw = () => {
    if (!liveLoopPaused) {
      player.tick()
      const t = player.time
      const state = renderFrameAt(t)
      scrub.value = String(Math.floor((t / Math.max(1e-6, player.duration)) * 1000))
      timeEl.textContent = `${t.toFixed(2)}s / ${player.duration.toFixed(2)}s`
      if (config.debug.hud) renderHud(hudEl, state, (window as unknown as { __source: EventSource }).__source)
      hudEl.classList.toggle('on', config.debug.hud)
    }
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)

  // Expose a controlled handle for the recorder to toggle the live loop.
  const liveLoopControl = {
    pause() { liveLoopPaused = true },
    resume() { liveLoopPaused = false },
    isPaused() { return liveLoopPaused },
    renderFrameAt,
  }

  // Expose for external render script (Playwright) and REPL debugging.
  ;(window as unknown as {
    __scenicsynths: {
      evaluate: typeof evaluate
      render: typeof render
      config: Config
      layout: typeof currentLayout
      font: typeof loaded.font
      source: EventSource
      player: Player
      computeAutoRowCount: typeof computeAutoRowCount
      computeRowLineHeight: typeof computeRowLineHeight
      keyRowFromConfig: typeof keyRowFromConfig
      setT: (t: number) => void
      renderFrameAt: (t: number) => void
    }
  }).__scenicsynths = {
    evaluate, render, config,
    get layout() { return currentLayout },
    font: loaded.font,
    source,
    player,
    computeAutoRowCount, computeRowLineHeight, keyRowFromConfig,
    setT: (t: number) => player.seek(t),
    renderFrameAt: (t: number) => { renderFrameAt(t) },
  }
  // Expose live-loop control for the recorder.
  ;(window as unknown as { __liveLoop: typeof liveLoopControl }).__liveLoop = liveLoopControl
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[scenicsynths] startup failed', err)
  const stage = document.getElementById('stage')
  if (stage) {
    const el = document.createElement('div')
    el.style.position = 'absolute'
    el.style.inset = '0'
    el.style.display = 'grid'
    el.style.placeItems = 'center'
    el.style.color = '#f66'
    el.style.font = '13px/1.4 ui-monospace, Menlo, monospace'
    el.style.padding = '12px'
    el.style.whiteSpace = 'pre-wrap'
    el.textContent = `scenicsynths startup failed:\n${String(err instanceof Error ? err.message : err)}`
    stage.appendChild(el)
  }
})
