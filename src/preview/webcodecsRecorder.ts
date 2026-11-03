import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

export interface WcRecordOptions {
  startAt: number           // seconds into the track
  duration: number          // seconds of ENGINE time to capture
  fps: number
  videoBitsPerSecond: number
  wallSlowdown: number      // 1 = render as fast as the browser can; >1 = pace frame drawing by (slowdown/fps) wall seconds (gives GPU more time, no effect on output timing)
}

export interface WcRecordDeps {
  canvas: HTMLCanvasElement
  renderFrameAt: (t: number) => void   // deterministic: evaluate(t) + render(ctx)
  onProgress?: (secondsRecorded: number, totalSeconds: number) => void
  onLog?: (msg: string) => void
}

export function webCodecsAvailable(): boolean {
  return typeof (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined' &&
    typeof (globalThis as unknown as { VideoFrame?: unknown }).VideoFrame !== 'undefined'
}

// Choose the first codec string that VideoEncoder reports as supported.
async function pickCodec(width: number, height: number, bitrate: number, fps: number): Promise<
  { codec: 'avc' | 'vp9', codecString: string }
> {
  const candidates: { codec: 'avc' | 'vp9'; codecString: string }[] = [
    // H.264 high profile 4.2 (1080p60), falls back to lower levels.
    { codec: 'avc', codecString: 'avc1.640028' },  // High@L4.0
    { codec: 'avc', codecString: 'avc1.42001f' },  // Baseline@L3.1
    { codec: 'vp9', codecString: 'vp09.00.10.08' },
  ]
  const VE = (globalThis as unknown as { VideoEncoder: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } }).VideoEncoder
  for (const c of candidates) {
    try {
      const r = await VE.isConfigSupported({
        codec: c.codecString,
        width, height, bitrate, framerate: fps,
      })
      if (r.supported) return c
    } catch { /* keep trying */ }
  }
  throw new Error('No supported WebCodecs video codec found')
}

export async function recordMp4(deps: WcRecordDeps, opts: WcRecordOptions): Promise<Blob> {
  const { canvas, renderFrameAt } = deps
  const log = deps.onLog ?? (() => {})
  if (!webCodecsAvailable()) throw new Error('WebCodecs not available in this browser')

  // Width/height must be even for most codecs.
  const width = canvas.width - (canvas.width % 2)
  const height = canvas.height - (canvas.height % 2)
  const fps = opts.fps
  const totalFrames = Math.round(opts.duration * fps)
  const bitrate = Math.max(1_000_000, Math.floor(opts.videoBitsPerSecond))

  const picked = await pickCodec(width, height, bitrate, fps)
  log(`[webcodecs] codec=${picked.codecString} size=${width}x${height} fps=${fps} bitrate=${bitrate}`)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: picked.codec,
      width,
      height,
      frameRate: fps,
    },
    fastStart: 'in-memory',
  })

  const VideoEncoderCtor = (globalThis as unknown as { VideoEncoder: new (init: { output: (chunk: unknown, meta: unknown) => void; error: (e: unknown) => void }) => {
    configure: (c: unknown) => void
    encode: (frame: unknown, opts?: { keyFrame?: boolean }) => void
    flush: () => Promise<void>
    close: () => void
    encodeQueueSize: number
  } }).VideoEncoder
  const VideoFrameCtor = (globalThis as unknown as { VideoFrame: new (src: HTMLCanvasElement, init: { timestamp: number; duration?: number }) => { close(): void } }).VideoFrame

  const encoder = new VideoEncoderCtor({
    output: (chunk, meta) => muxer.addVideoChunk(chunk as EncodedVideoChunk, meta as EncodedVideoChunkMetadata),
    error: (e) => log(`[webcodecs] encoder error: ${String(e)}`),
  })
  encoder.configure({
    codec: picked.codecString,
    width,
    height,
    bitrate,
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
  })

  const microPerFrame = Math.floor(1_000_000 / fps)
  const wallGapMs = Math.max(0, (opts.wallSlowdown || 0) * (1000 / fps))

  for (let i = 0; i < totalFrames; i++) {
    const engineT = opts.startAt + i / fps
    renderFrameAt(engineT)

    // Backpressure: if encoder queue grows, wait a tick so we don't OOM.
    while (encoder.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 2))
    }

    const frame = new VideoFrameCtor(canvas, {
      timestamp: i * microPerFrame,
      duration: microPerFrame,
    })
    // Force a keyframe periodically so seeking works and the file isn't a single giant GOP.
    const keyFrame = i === 0 || i % Math.max(fps, 30) === 0
    encoder.encode(frame as unknown as VideoFrame, { keyFrame })
    frame.close()

    deps.onProgress?.(i / fps, opts.duration)

    if (wallGapMs > 0) await new Promise((r) => setTimeout(r, wallGapMs))
    // Yield to the event loop occasionally so the UI stays responsive even without wallGap.
    else if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0))
  }

  await encoder.flush()
  encoder.close()
  muxer.finalize()
  const buf = (muxer.target as ArrayBufferTarget).buffer
  return new Blob([buf], { type: 'video/mp4' })
}
