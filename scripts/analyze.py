#!/usr/bin/env python3
"""
scenicsynths audio analyzer.

Reads a WAV, estimates tempo/beats, detects per-band transients (kick, snare,
mid, hats), computes continuous per-band envelopes resampled to a target FPS,
and emits a JSON file consumable by the TypeScript renderer plus a diagnostic
PNG.

Usage:
    python analyze.py --input assets/audio/track.wav \
        [--output analysis/track.json] [--fps 60] [--stems] \
        [--plot analysis/track.png] \
        [--kick-lo 30 --kick-hi 150 ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# Lazy heavy imports happen inside functions where possible, but we need these
# at module scope so type hints and most functions stay readable.
try:
    import librosa
    import soundfile as sf
except ImportError as e:  # pragma: no cover
    print(f"error: missing required dep: {e}. Install from requirements.txt",
          file=sys.stderr)
    raise

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


# ---------- STFT config ----------
N_FFT = 2048
HOP_LENGTH = 512  # ~11.6 ms at 44.1k; interpolated to fps for envelopes


# ---------- Band config ----------
@dataclass
class BandCfg:
    name: str
    lo: float
    hi: float
    k: float            # MAD multiplier for adaptive threshold
    refractory_ms: float


def default_bands(args: argparse.Namespace) -> Dict[str, BandCfg]:
    """Build band configs from CLI args (defaults match spec)."""
    return {
        "kick":  BandCfg("kick",  args.kick_lo,  args.kick_hi,  args.k_kick,  args.ref_kick),
        # snare body band; crack band is handled specially inside detector
        "snare": BandCfg("snare", args.snare_lo, args.snare_hi, args.k_snare, args.ref_snare),
        "mid":   BandCfg("mid",   args.mid_lo,   args.mid_hi,   args.k_mid,   args.ref_mid),
        "hats":  BandCfg("hats",  args.hats_lo,  args.hats_hi,  args.k_hats,  args.ref_hats),
    }


# ---------- Audio IO ----------
def load_audio(path: str) -> Tuple[np.ndarray, int]:
    """Load audio file as mono float32 at native sample rate."""
    if not os.path.isfile(path):
        raise FileNotFoundError(f"input audio not found: {path}")
    try:
        y, sr = sf.read(path, always_2d=False)
    except Exception as e:
        raise RuntimeError(f"failed to read audio {path}: {e}") from e
    if sr <= 0:
        raise ValueError(f"invalid sample rate {sr} in {path}")
    y = np.asarray(y, dtype=np.float32)
    if y.ndim > 1:
        y = y.mean(axis=1).astype(np.float32)
    if y.size == 0:
        raise ValueError(f"empty audio buffer in {path}")
    return y, int(sr)


# ---------- STFT and band slicing ----------
def compute_stft_mag(y: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Return magnitude STFT (bins, frames) and frame times (seconds)."""
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH, center=True))
    return S.astype(np.float32), None  # frame times computed by caller using sr


def bin_range_for_band(sr: int, lo: float, hi: float) -> Tuple[int, int]:
    """Compute STFT bin indices covering [lo, hi] Hz (inclusive-exclusive)."""
    freqs = np.linspace(0, sr / 2, N_FFT // 2 + 1)
    lo_i = int(np.searchsorted(freqs, max(0.0, lo), side="left"))
    hi_i = int(np.searchsorted(freqs, min(sr / 2, hi), side="right"))
    lo_i = max(0, min(lo_i, len(freqs) - 1))
    hi_i = max(lo_i + 1, min(hi_i, len(freqs)))
    return lo_i, hi_i


def spectral_flux(S: np.ndarray, lo_i: int, hi_i: int) -> np.ndarray:
    """Positive first-difference spectral flux across the given bin range."""
    band = S[lo_i:hi_i, :]
    diff = np.diff(band, axis=1, prepend=band[:, :1])
    diff = np.maximum(diff, 0.0)
    flux = diff.sum(axis=0)
    return flux.astype(np.float32)


# ---------- Adaptive thresholding + peak picking ----------
def rolling_median_mad(x: np.ndarray, win: int) -> Tuple[np.ndarray, np.ndarray]:
    """
    Rolling median and MAD across a centered window of `win` frames.

    Uses a cumulative approach via sorted sliding windows would be ideal, but
    scipy.ndimage is more than adequate here.
    """
    from scipy.ndimage import median_filter
    med = median_filter(x, size=win, mode="reflect")
    mad = median_filter(np.abs(x - med), size=win, mode="reflect")
    return med, mad


def pick_peaks(
    flux: np.ndarray,
    frame_times: np.ndarray,
    k: float,
    refractory_s: float,
    window_s: float = 0.5,
    frame_dt: float = HOP_LENGTH / 44100.0,  # overridden by caller via arg if needed
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Adaptive threshold peak picking.

    Returns (onset_frame_indices, onset_strengths_raw).
    """
    if flux.size == 0:
        return np.array([], dtype=int), np.array([], dtype=np.float32)

    # window length in frames, odd for symmetry
    win = max(3, int(round(window_s / frame_dt)))
    if win % 2 == 0:
        win += 1
    med, mad = rolling_median_mad(flux, win)
    thresh = med + k * (mad + 1e-9)

    above = flux > thresh
    # local maxima
    peaks: List[int] = []
    strengths: List[float] = []
    last_t = -1e9
    for i in range(1, len(flux) - 1):
        if not above[i]:
            continue
        if not (flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]):
            continue
        t = frame_times[i]
        if t - last_t < refractory_s:
            # keep the stronger
            if peaks and flux[i] > strengths[-1]:
                peaks[-1] = i
                strengths[-1] = float(flux[i])
                last_t = t
            continue
        peaks.append(i)
        strengths.append(float(flux[i]))
        last_t = t
    return np.array(peaks, dtype=int), np.array(strengths, dtype=np.float32)


def normalize_strengths(
    strengths_raw: np.ndarray, flux: np.ndarray
) -> np.ndarray:
    """Divide by rolling 99th percentile of flux across the whole track; clamp."""
    if flux.size == 0:
        return strengths_raw
    denom = float(np.percentile(flux, 99.0))
    if denom <= 1e-9:
        denom = float(flux.max() + 1e-9)
    out = np.clip(strengths_raw / denom, 0.0, 1.0)
    return out.astype(np.float32)


# ---------- Snare: body + crack with coincidence gating ----------
def detect_snare(
    S: np.ndarray,
    sr: int,
    frame_times: np.ndarray,
    frame_dt: float,
    cfg: BandCfg,
    args: argparse.Namespace,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Snare detection with body+crack combination and coincidence requirement.

    Returns (onset_frame_indices, strengths_norm, combined_flux_for_env).
    """
    body_lo_i, body_hi_i = bin_range_for_band(sr, cfg.lo, cfg.hi)
    crack_lo_i, crack_hi_i = bin_range_for_band(sr, args.snare_crack_lo, args.snare_crack_hi)

    flux_body = spectral_flux(S, body_lo_i, body_hi_i)
    flux_crack = spectral_flux(S, crack_lo_i, crack_hi_i)

    # Normalize each band roughly before weighting so the sum is well-balanced
    def _norm(x: np.ndarray) -> np.ndarray:
        d = float(np.percentile(x, 99.0)) if x.size else 1.0
        if d < 1e-9:
            d = float(x.max() + 1e-9) if x.size else 1.0
        return x / max(d, 1e-9)

    b = _norm(flux_body)
    c = _norm(flux_crack)
    combined = args.snare_body_w * b + args.snare_crack_w * c

    # Coincidence: both bands must exceed small inner thresholds within +/- 30 ms
    coinc_win = max(1, int(round(0.030 / frame_dt)))
    inner_thresh = args.snare_inner_thresh  # on normalized flux
    b_hot = b > inner_thresh
    c_hot = c > inner_thresh
    # dilate each by +/- coinc_win
    from scipy.ndimage import maximum_filter1d
    b_dil = maximum_filter1d(b_hot.astype(np.uint8), size=2 * coinc_win + 1) > 0
    c_dil = maximum_filter1d(c_hot.astype(np.uint8), size=2 * coinc_win + 1) > 0
    coinc_mask = b_dil & c_dil
    # Attenuate combined where coincidence fails. Factor 0.2 is strong but not zero
    # so very prominent events still show up.
    gated = np.where(coinc_mask, combined, combined * 0.2).astype(np.float32)

    idx, raw = pick_peaks(
        gated, frame_times, cfg.k, cfg.refractory_ms / 1000.0,
        window_s=0.5, frame_dt=frame_dt,
    )
    strengths = normalize_strengths(raw, gated)
    return idx, strengths, gated


# ---------- Simple-band detect wrapper ----------
def detect_band(
    S: np.ndarray,
    sr: int,
    frame_times: np.ndarray,
    frame_dt: float,
    cfg: BandCfg,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Generic per-band onset detection via spectral flux + adaptive threshold."""
    lo_i, hi_i = bin_range_for_band(sr, cfg.lo, cfg.hi)
    flux = spectral_flux(S, lo_i, hi_i)
    idx, raw = pick_peaks(
        flux, frame_times, cfg.k, cfg.refractory_ms / 1000.0,
        window_s=0.5, frame_dt=frame_dt,
    )
    strengths = normalize_strengths(raw, flux)
    return idx, strengths, flux


# ---------- Envelope resampling ----------
def envelope_to_fps(
    flux: np.ndarray,
    frame_times: np.ndarray,
    duration: float,
    fps: int,
) -> List[float]:
    """
    Resample a frame-rate envelope to `fps` samples per second over `duration`,
    normalized to [0, 1] by the 99th percentile.
    """
    n_out = max(1, int(round(duration * fps)))
    t_out = np.linspace(0.0, duration, n_out, endpoint=False)
    if flux.size == 0:
        return [0.0] * n_out
    env = np.interp(t_out, frame_times, flux, left=0.0, right=0.0)
    denom = float(np.percentile(flux, 99.0))
    if denom <= 1e-9:
        denom = float(flux.max() + 1e-9)
    env = np.clip(env / denom, 0.0, 1.0)
    return [float(v) for v in env]


# ---------- Beat / downbeat tracking ----------
def track_beats(y: np.ndarray, sr: int) -> Tuple[float, List[float], List[float]]:
    """
    Estimate BPM and beat times. Downbeats are a best-effort guess: every 4th
    beat starting from the first. librosa doesn't ship a robust downbeat
    tracker, so this is a reasonable fallback for 4/4 content.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP_LENGTH)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH).tolist()
    # Note: naive downbeat guess — every 4th beat. Replace with madmom later if desired.
    downbeats = beat_times[::4]
    bpm = float(np.atleast_1d(tempo)[0])
    return bpm, [float(t) for t in beat_times], [float(t) for t in downbeats]


# ---------- Optional stem separation ----------
def maybe_separate_stems(
    y: np.ndarray, sr: int
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Try to separate drums and 'other' using demucs. Returns (drums, other) or
    (None, None) if demucs isn't available or fails. Both are mono float32.
    """
    try:
        import torch  # noqa: F401
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except Exception as e:
        print(f"warning: demucs not available ({e}); skipping stem separation",
              file=sys.stderr)
        return None, None
    try:
        model = get_model(name="htdemucs")
        model.cpu().eval()
        # demucs expects shape (batch, channels, samples) at model.samplerate
        import torch
        y_rs = librosa.resample(y, orig_sr=sr, target_sr=model.samplerate) if sr != model.samplerate else y
        wav = torch.from_numpy(np.stack([y_rs, y_rs])[None, ...])  # fake stereo
        with torch.no_grad():
            sources = apply_model(model, wav, split=True, overlap=0.1, progress=False)
        # sources shape: (batch, source, channels, samples); source order from model.sources
        names = model.sources
        src_map: Dict[str, np.ndarray] = {}
        for i, name in enumerate(names):
            s = sources[0, i].mean(dim=0).cpu().numpy().astype(np.float32)
            if model.samplerate != sr:
                s = librosa.resample(s, orig_sr=model.samplerate, target_sr=sr)
            src_map[name] = s
        drums = src_map.get("drums")
        other_keys = [k for k in src_map.keys() if k != "drums"]
        other = np.sum(np.stack([src_map[k] for k in other_keys], axis=0), axis=0) if other_keys else None
        return drums, other
    except Exception as e:
        print(f"warning: demucs separation failed ({e}); skipping", file=sys.stderr)
        return None, None


# ---------- Plot ----------
def write_plot(
    plot_path: str,
    y: np.ndarray,
    sr: int,
    duration: float,
    envelopes: Dict[str, np.ndarray],
    onsets: Dict[str, np.ndarray],
    bpm: float,
) -> None:
    """Diagnostic 4-panel plot: waveform + envelope + onsets per band."""
    fig, axes = plt.subplots(4, 1, figsize=(14, 10), sharex=True)
    t_wave = np.linspace(0.0, duration, len(y))
    # downsample waveform for display
    stride = max(1, len(y) // 20000)
    for ax, band in zip(axes, ["kick", "snare", "mid", "hats"]):
        ax.plot(t_wave[::stride], y[::stride], color="#999", linewidth=0.5, alpha=0.5, label="wave")
        env = envelopes[band]
        t_env = np.linspace(0.0, duration, len(env))
        ax.plot(t_env, env, color="C0", linewidth=1.0, label="envelope")
        for t in onsets[band]:
            ax.axvline(float(t), color="C3", alpha=0.6, linewidth=0.7)
        ax.set_title(f"{band} — bpm={bpm:.1f}, onsets={len(onsets[band])}")
        ax.set_ylim(-1.05, 1.05)
        ax.set_ylabel(band)
    axes[-1].set_xlabel("time (s)")
    fig.tight_layout()
    Path(plot_path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(plot_path, dpi=110)
    plt.close(fig)


# ---------- CLI ----------
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="scenicsynths audio analyzer")
    p.add_argument("--input", required=True, help="input wav file")
    p.add_argument("--output", default=None, help="output json path")
    p.add_argument("--plot", default=None, help="diagnostic png path")
    p.add_argument("--fps", type=int, default=60)
    p.add_argument("--stems", action="store_true", help="use demucs to separate stems")
    p.add_argument("--track-name", default=None, help="track name in JSON (defaults to basename)")

    # band bounds (Hz)
    p.add_argument("--kick-lo", type=float, default=30.0)
    p.add_argument("--kick-hi", type=float, default=150.0)
    p.add_argument("--snare-lo", type=float, default=150.0)
    p.add_argument("--snare-hi", type=float, default=400.0)
    p.add_argument("--snare-crack-lo", type=float, default=1500.0)
    p.add_argument("--snare-crack-hi", type=float, default=5000.0)
    p.add_argument("--snare-body-w", type=float, default=0.6)
    p.add_argument("--snare-crack-w", type=float, default=0.4)
    p.add_argument("--snare-inner-thresh", type=float, default=0.25,
                   help="inner threshold on normalized body/crack flux for coincidence")
    p.add_argument("--mid-lo", type=float, default=400.0)
    p.add_argument("--mid-hi", type=float, default=4000.0)
    p.add_argument("--hats-lo", type=float, default=6000.0)
    p.add_argument("--hats-hi", type=float, default=16000.0)

    # thresholds and refractory periods
    p.add_argument("--k-kick", type=float, default=2.0)
    p.add_argument("--k-snare", type=float, default=2.0)
    p.add_argument("--k-mid", type=float, default=2.0)
    p.add_argument("--k-hats", type=float, default=1.5)
    p.add_argument("--ref-kick", type=float, default=70.0, help="ms")
    p.add_argument("--ref-snare", type=float, default=70.0)
    p.add_argument("--ref-mid", type=float, default=50.0)
    p.add_argument("--ref-hats", type=float, default=30.0)

    return p.parse_args(argv)


def derive_paths(args: argparse.Namespace) -> Tuple[str, str, str]:
    """Return (output_json, plot_png, track_name)."""
    in_path = Path(args.input)
    base = in_path.stem
    out = args.output or str(Path("analysis") / f"{base}.json")
    plot = args.plot or str(Path("analysis") / f"{base}.png")
    name = args.track_name or base
    return out, plot, name


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    out_json, out_plot, track_name = derive_paths(args)

    try:
        y, sr = load_audio(args.input)
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    duration = float(len(y) / sr)
    bpm, beats, downbeats = track_beats(y, sr)

    # Optional stems
    drums = None
    other = None
    if args.stems:
        drums, other = maybe_separate_stems(y, sr)

    # Build STFTs per source
    y_for_drums = drums if drums is not None else y
    y_for_rest = other if other is not None else y

    S_drums = np.abs(librosa.stft(y_for_drums, n_fft=N_FFT, hop_length=HOP_LENGTH, center=True)).astype(np.float32)
    S_rest = np.abs(librosa.stft(y_for_rest, n_fft=N_FFT, hop_length=HOP_LENGTH, center=True)).astype(np.float32)
    frame_times = librosa.frames_to_time(np.arange(S_drums.shape[1]), sr=sr, hop_length=HOP_LENGTH).astype(np.float32)
    frame_dt = HOP_LENGTH / float(sr)

    bands = default_bands(args)
    onsets_t: Dict[str, List[Dict[str, float]]] = {}
    onsets_times: Dict[str, np.ndarray] = {}
    envelopes_out: Dict[str, List[float]] = {}
    env_arrays: Dict[str, np.ndarray] = {}

    # kick (from drums source)
    for band_name, S_src in [("kick", S_drums), ("mid", S_rest), ("hats", S_rest)]:
        cfg = bands[band_name]
        idx, strengths, flux = detect_band(S_src, sr, frame_times, frame_dt, cfg)
        times = frame_times[idx] if idx.size else np.array([], dtype=np.float32)
        onsets_t[band_name] = [
            {"t": round(float(times[i]), 4), "strength": round(float(strengths[i]), 4)}
            for i in range(len(idx))
        ]
        onsets_times[band_name] = times
        env_arrays[band_name] = flux
        envelopes_out[band_name] = envelope_to_fps(flux, frame_times, duration, args.fps)

    # snare — body + crack coincidence, from drums source
    cfg = bands["snare"]
    idx, strengths, flux = detect_snare(S_drums, sr, frame_times, frame_dt, cfg, args)
    times = frame_times[idx] if idx.size else np.array([], dtype=np.float32)
    onsets_t["snare"] = [
        {"t": round(float(times[i]), 4), "strength": round(float(strengths[i]), 4)}
        for i in range(len(idx))
    ]
    onsets_times["snare"] = times
    env_arrays["snare"] = flux
    envelopes_out["snare"] = envelope_to_fps(flux, frame_times, duration, args.fps)

    # Assemble JSON
    payload = {
        "track": track_name,
        "bpm": round(float(bpm), 3),
        "duration": round(duration, 4),
        "sampleRate": int(sr),
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "bands": {
            "kick":  onsets_t["kick"],
            "snare": onsets_t["snare"],
            "mid":   onsets_t["mid"],
            "hats":  onsets_t["hats"],
        },
        "envelopes": {
            "fps": int(args.fps),
            "bands": {
                "kick":  envelopes_out["kick"],
                "snare": envelopes_out["snare"],
                "mid":   envelopes_out["mid"],
                "hats":  envelopes_out["hats"],
            },
        },
    }

    Path(out_json).parent.mkdir(parents=True, exist_ok=True)
    # Compact arrays, pretty top level. We dump with indent=2; this is simpler
    # and the renderer handles either shape.
    with open(out_json, "w") as f:
        json.dump(payload, f, indent=2)

    # Plot
    try:
        write_plot(out_plot, y, sr, duration,
                   envelopes={k: np.array(v, dtype=np.float32) for k, v in envelopes_out.items()},
                   onsets=onsets_times, bpm=bpm)
    except Exception as e:
        print(f"warning: plot failed: {e}", file=sys.stderr)

    print(
        f"track={track_name} bpm={bpm:.1f} "
        f"kick={len(onsets_t['kick'])} snare={len(onsets_t['snare'])} "
        f"mid={len(onsets_t['mid'])} hats={len(onsets_t['hats'])} "
        f"-> {out_json}, {out_plot}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
