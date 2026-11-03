import type { Player } from './player'

export interface RecordOptions {
  startAt: number           // seconds into the track
  duration: number          // seconds to capture
  fps: number
  videoBitsPerSecond: number
  mimeType?: string
}

export interface RecordDeps {
  canvas: HTMLCanvasElement
  player: Player
  audioEl: HTMLAudioElement | null
  onProgress?: (secondsRecorded: number) => void
  onLog?: (msg: string) => void
}

// Record the canvas with audio via captureStream + MediaRecorder.
// Returns a webm blob. Chrome/Arc produce vp9/opus; convert to h264 mp4 via `ffmpeg -i in.webm -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac out.mp4`.
export async function recordWebm(deps: RecordDeps, opts: RecordOptions): Promise<Blob> {
  const { canvas, player, audioEl } = deps
  const log = deps.onLog ?? (() => {})

  // Pick a supported mime; prefer vp9 for quality, fall back to vp8 then default webm.
  const candidates = [
    opts.mimeType,
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ].filter((x): x is string => !!x)
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'

  // Build the combined MediaStream.
  const videoStream = canvas.captureStream(opts.fps)
  const combined = new MediaStream()
  for (const t of videoStream.getVideoTracks()) combined.addTrack(t)

  if (audioEl) {
    try {
      type AudioElementWithCapture = HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }
      const el = audioEl as AudioElementWithCapture
      const capture = el.captureStream ?? el.mozCaptureStream
      if (!capture) {
        log(`[record] audio.captureStream unavailable; recording video only`)
      } else {
        const audioStream = capture.call(el)
        for (const t of audioStream.getAudioTracks()) combined.addTrack(t)
      }
    } catch (err) {
      log(`[record] audio capture failed: ${String((err as Error)?.message ?? err)} — video only`)
    }
  }

  const recorder = new MediaRecorder(combined, {
    mimeType,
    videoBitsPerSecond: opts.videoBitsPerSecond,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onerror = (e) => reject(new Error(`MediaRecorder error: ${String(e)}`))
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
  })

  // Seek, start playback, start recording.
  player.seek(opts.startAt)
  // Small delay to let audio element seek complete.
  await new Promise((r) => setTimeout(r, 120))
  await player.play()

  log(`[record] mimeType=${mimeType} fps=${opts.fps} bitrate=${opts.videoBitsPerSecond} audio=${audioEl ? 'yes' : 'no'}`)
  recorder.start(100)

  const startWall = performance.now()
  const tick = () => {
    const elapsed = (performance.now() - startWall) / 1000
    deps.onProgress?.(elapsed)
    if (elapsed >= opts.duration) {
      recorder.stop()
      player.pause()
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  return done
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 1000)
}

export function buildRenderCliCommand(opts: {
  track: string | null
  startAt: number
  duration: number
  fps: number
  width: number
  height: number
}): string {
  const name = opts.track ?? '<track>'
  const end = opts.startAt + opts.duration
  return [
    'npm run render --',
    `--track ${name}`,
    `--fps ${opts.fps}`,
    `--size ${opts.width}x${opts.height}`,
    `--start ${opts.startAt}`,
    `--end ${end.toFixed(3)}`,
  ].join(' ')
}
