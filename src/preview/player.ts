export interface PlayerOptions {
  audioUrl: string | null
  duration: number
}

// Lightweight transport: wraps an HTMLAudioElement when audio is loaded, else a monotonic clock.
export class Player {
  private audio: HTMLAudioElement | null = null
  private clockStart = 0
  private running = false
  private _time = 0
  readonly duration: number

  loopStart = 0
  loopEnd: number | null = null

  constructor(opts: PlayerOptions) {
    this.duration = opts.duration
    if (opts.audioUrl) {
      const a = new Audio()
      a.src = opts.audioUrl
      a.preload = 'auto'
      a.loop = false
      a.crossOrigin = 'anonymous'
      this.audio = a
    }
  }

  async ready(): Promise<void> {
    if (!this.audio) return
    await new Promise<void>((resolve, reject) => {
      const a = this.audio!
      if (a.readyState >= 2) return resolve()
      a.addEventListener('canplay', () => resolve(), { once: true })
      a.addEventListener('error', (e) => reject(e), { once: true })
    })
  }

  get time(): number {
    if (this.audio) return this.audio.currentTime
    if (this.running) return (performance.now() - this.clockStart) / 1000
    return this._time
  }

  async play(): Promise<void> {
    if (this.audio) {
      await this.audio.play()
      this.running = true
    } else {
      this.clockStart = performance.now() - this._time * 1000
      this.running = true
    }
  }

  pause(): void {
    if (this.audio) {
      this._time = this.audio.currentTime
      this.audio.pause()
    } else {
      this._time = (performance.now() - this.clockStart) / 1000
    }
    this.running = false
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(this.duration, t))
    this._time = clamped
    if (this.audio) this.audio.currentTime = clamped
    else if (this.running) this.clockStart = performance.now() - clamped * 1000
  }

  get isPlaying(): boolean { return this.running }
  get audioElement(): HTMLAudioElement | null { return this.audio }

  tick(): void {
    if (this.loopEnd !== null && this.time >= this.loopEnd) {
      this.seek(this.loopStart)
    }
  }
}
