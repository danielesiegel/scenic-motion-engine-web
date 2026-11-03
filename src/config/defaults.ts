import type { Config } from '../types'

export const DEFAULT_CONFIG: Config = {
  text: {
    unit: 'scenicsynth',
    key: 'scenicsynths',
    case: 'lower',
  },
  layout: {
    fontSizePx: 72,
    leadingPx: 0,
    rows: 'auto',
    rowStaggerPx: 0.33,
    rotationDeg: 0,
    marginPx: 0,
  },
  colors: {
    background: '#0b0b0b',
    dim: '#2c2c2c',
    key: '#d6d6d6',
  },
  key: {
    rows: 'all',
    singleRow: 'middle',
    frequency: 10,
    offsetUnits: 0,
    rowPhaseOffset: true,
    mode: 'travels',
    anchorScreenOffsetPx: 0,
  },
  canvas: {
    width: 1920,
    height: 1080,
    dpr: 1,
    renderScale: 2,                       // live rendering supersample; raise for cleaner on-screen text
  },
  audio: {
    track: null,
    analysisUrl: null,
  },
  tickers: [
    // Row motion drivers (one per band so the different row-parities feel in-sync but distinct).
    { id: 'kick-even-slide',  band: 'kick',  modulo: 1, strengthThreshold: 0.25 },
    { id: 'snare-odd-slide',  band: 'snare', modulo: 1, strengthThreshold: 0.25 },
    { id: 'mid-all-drift',    band: 'mid',   modulo: 2, strengthThreshold: 0.15 },
    { id: 'hats-all-jitter',  band: 'hats',  modulo: 1, strengthThreshold: 0.55 },

    // Camera tickers — fire every 4th kick for zoom/pan (at indices 3,7,11,...),
    // and every 4th kick offset by 2 for tilt (indices 1,5,9,...).
    { id: 'kick-camera-zoompan', band: 'kick', modulo: 4, step: 4, stepOffset: 3, strengthThreshold: 0.25 },
    // Modulo-2 oscillation. Combined with camera.baseline.tilt = -10 this see-saws between +10 and -10.
    { id: 'kick-camera-tilt',    band: 'kick', modulo: 2, step: 4, stepOffset: 1, strengthThreshold: 0.25 },
  ],
  bindings: [
    // --- Row motion: even and odd ride different bands at different speeds ---
    {
      tickerId: 'kick-even-slide',
      target: 'rows',
      rows: 'even',
      compose: 'add',
      sequence: {
        actions: [
          { path: 'slideStep', params: { units: 1 }, duration: 0.25, easing: 'easeOutCubic' },
        ],
      },
    },
    {
      tickerId: 'snare-odd-slide',
      target: 'rows',
      rows: 'odd',
      compose: 'add',
      sequence: {
        actions: [
          // Odd rows (dir=-1 after alternation) scroll opposite; use a slightly bigger step so the two feel syncopated.
          { path: 'slideStep', params: { units: 1.5 }, duration: 0.30, easing: 'easeOutCubic' },
        ],
      },
    },
    {
      tickerId: 'mid-all-drift',
      target: 'rows',
      rows: 'all',
      compose: 'add',
      sequence: {
        actions: [
          { path: 'driftSpeed', params: { pxPerSec: 14 },  duration: 2.0, easing: 'linear' },
          { path: 'driftSpeed', params: { pxPerSec: -14 }, duration: 2.0, easing: 'linear' },
        ],
      },
    },
    {
      tickerId: 'hats-all-jitter',
      target: 'rows',
      rows: 'all',
      compose: 'add',
      sequence: {
        actions: [
          // Tiny, strong-only jitter so dense hats don't flood the frame with shimmer.
          { path: 'glyphJitter', params: { amplitude: 0.6 }, duration: 0.08, easing: 'linear' },
        ],
      },
    },

    // --- Camera bindings ---
    // Zoom/pan cycle on every 4th kick. Zoom-in uses a focused variant that picks a random
    // in-bounds focal point per event, so each cycle zooms into a different sub-region.
    {
      tickerId: 'kick-camera-zoompan',
      target: 'camera',
      compose: 'add',
      sequence: {
        actions: [
          { path: 'cameraZoomDeltaFocused', params: { deltaScale: 0.10, focusFrac: 0.6 }, duration: 0.45, easing: 'easeOutCubic' },
          { path: 'cameraZoomDeltaFocused', params: { deltaScale: -0.10, focusFrac: 0.6 }, duration: 0.45, easing: 'easeOutCubic' },
          { path: 'cameraPanDelta',  params: { deltaPx:    80    }, duration: 0.45, easing: 'easeOutCubic' },
          { path: 'cameraPanDelta',  params: { deltaPx:   -80    }, duration: 0.45, easing: 'easeOutCubic' },
        ],
      },
    },
    // Half the previous tilt magnitude. Baseline -5°, deltas ±10° → see-saws between +5° and -5°.
    {
      tickerId: 'kick-camera-tilt',
      target: 'camera',
      compose: 'add',
      sequence: {
        actions: [
          { path: 'cameraTiltDelta', params: { deltaDegrees:  10 }, duration: 0.40, easing: 'easeOutCubic' },
          { path: 'cameraTiltDelta', params: { deltaDegrees: -10 }, duration: 0.40, easing: 'easeOutCubic' },
        ],
      },
    },
  ],
  bandThresholds: {
    kick: 0.85,
    snare: 0.60,
    mid: 0.50,
    hats: 0.40,
  },
  camera: {
    // Baseline + modulo-2 ±10° deltas → visible tilt see-saws between -5° and +5° (half the prior magnitude).
    baseline: { zoom: 1, panX: 0, panY: 0, tilt: -5 },
    rowOvershoot: 3,
  },
  feel: {
    preset: 'default',
    durationScale: 1.0,
    globalEasing: 'auto',
    horizontalScale: 1.0,
    rowVelocityShape: 'u',          // U-curve: 2× at top and bottom, 1× in the middle
    rowVelocityEdgeScale: 2.0,
  },
  record: {
    startAt: 0,
    duration: 10,
    fps: 60,
    videoBitrateMbps: 20,
    resolutionMultiplier: 2,
    engine: 'auto',          // auto = WebCodecs MP4 if available, else MediaRecorder slow-mo webm
    renderSlowdown: 1,       // for mediarecorder fallback: 4 means render + capture at 25% speed to prevent frame drops
  },
  debug: {
    hud: false,
  },
}
