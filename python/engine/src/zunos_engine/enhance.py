"""Measure a recorded take and clean its background noise, without touching the raw file.

Which version feeds what (see library.ts):
  - training input (16 kHz clips) and the test set: the RAW take. Dictation hears the raw microphone, so the
    model should learn and be scored on that; the pod adds noise itself, using the raw takes as room tone.
  - voice-cloning references (48 kHz clips): the CLEANED take. A TTS model copies whatever is in its
    reference, background hum included, into hours of synthetic speech.

Chain (enhance): DC and rumble high-pass (+ mains-hum notches when there is hum) -> gain to a fixed speech
level with a peak limiter, BEFORE denoising, so quiet speech isn't treated as noise -> DPDFNet-8 (48 kHz,
github.com/ceva-ip/DPDFNet, Apache-2.0) -> mixed back with its input at a strength set by the measured SNR
(alpha * input + (1 - alpha) * denoised, alpha = 10^(-limit/20): the denoiser can lower the noise by at most
`limit` dB, which also caps how much it can eat into speech) -> guardrails that step the strength down for
this take when speech loses level or a quick Whisper-base check transcribes the cleaned take worse than
the raw one -> loudness normalization (-20 LUFS) with a limiter.
"""
import math
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy import signal

DENOISER_REPO = "Ceva-IP/DPDFNet"
DENOISER_FILE = "onnx/dpdfnet8_48khz_hr.onnx"
ASR_REPO = "mlx-community/whisper-base-mlx"
RATE = 48000

FRAME = 0.02  # analysis frame and hop (seconds)
HOP = 0.01
SPEECH_TARGET_DB = -26.0  # active speech level fed to the denoiser (dBFS), the middle of what it was trained on
OUT_LUFS = -20.0  # final loudness of the cleaned take (the level the pod normalizes references to)
CEILING = 10 ** (-1.0 / 20)  # limiter ceiling, -1 dBFS
MAX_GAIN_DB = 30.0

# Strength: the most the denoiser may lower the noise (dB). Above CLEAN_SNR the take is left as recorded.
CLEAN_SNR = 42.0
MAX_LIMIT = 24.0
MIN_LIMIT = 6.0
# Guardrails.
# The Whisper-base check: cleaned may score at most max(ASR_SLACK, ASR_WORDS / words) worse than raw (a word
# and a half of slack, so one flipped word in a short take isn't a verdict), and only counts when base can
# read the raw take (error <= ASR_INFORMATIVE): on speech it mostly misreads (base on Hindi and Gujarati sits
# around 0.55), its errors swing by 0.2 between near-identical inputs and say nothing.
ASR_SLACK = 0.03
ASR_WORDS = 1.5
ASR_INFORMATIVE = 0.5
# Level guard on clearly-speech frames (300-4000 Hz). A 10th-percentile loss past LEVEL_DROP_DB is suspect: loud
# keyboard clicks or babble count as "clear" frames and are meant to go, so when the Whisper check can judge,
# it decides; without it the strength steps down. A median loss past LEVEL_HARD_DB always steps down.
LEVEL_DROP_DB = 3.0
LEVEL_HARD_DB = 6.0


def strength_for(snr_db):
    """Noise attenuation limit (dB) for a take with this SNR: none for clean takes, 6-24 dB otherwise."""
    if snr_db is None or snr_db >= CLEAN_SNR:
        return 0.0
    return float(np.clip(round((CLEAN_SNR - snr_db) * 0.9), MIN_LIMIT, MAX_LIMIT))


# ------------------------------------------------------------------------------------------- measuring

def db(p):
    return 10 * np.log10(np.maximum(p, 1e-12))


def frame_power(x, sr, frame=FRAME, hop=HOP):
    n, h = int(sr * frame), int(sr * hop)
    if len(x) < n:
        return np.array([np.mean(x ** 2)]) if len(x) else np.zeros(1)
    idx = np.arange(0, len(x) - n + 1, h)
    sq = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    return (sq[idx + n] - sq[idx]) / n


def k_weight(x, sr):
    """ITU-R BS.1770 K-weighting (high shelf + high pass), coefficients for any rate."""
    out = x
    for kind, g, q, fc in (("shelf", 4.0, 1 / math.sqrt(2), 1500.0), ("hp", 0.0, 0.5, 38.0)):
        a_ = 10 ** (g / 40)
        w0 = 2 * math.pi * fc / sr
        al, c = math.sin(w0) / (2 * q), math.cos(w0)
        if kind == "shelf":
            r = 2 * math.sqrt(a_) * al
            b = [a_ * ((a_ + 1) + (a_ - 1) * c + r), -2 * a_ * ((a_ - 1) + (a_ + 1) * c), a_ * ((a_ + 1) + (a_ - 1) * c - r)]
            a = [(a_ + 1) - (a_ - 1) * c + r, 2 * ((a_ - 1) - (a_ + 1) * c), (a_ + 1) - (a_ - 1) * c - r]
        else:
            b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
            a = [1 + al, -2 * c, 1 - al]
        out = signal.lfilter(b, a, out)
    return out


def lufs(x, sr):
    """Integrated loudness (BS.1770-4, mono): 400 ms blocks, absolute gate -70, relative gate -10 LU."""
    z = frame_power(k_weight(x, sr), sr, 0.4, 0.1)
    if len(z) == 0:
        return -120.0
    l = -0.691 + db(z)
    z = z[l > -70]
    if len(z) == 0:
        return -120.0
    z = z[-0.691 + db(z) > -0.691 + db(z.mean()) - 10]
    return float(-0.691 + db(z.mean()))


def voiced(p_db, noise_db):
    """Frames clearly above the noise floor (speech), with 100 ms of hangover."""
    top = np.percentile(p_db, 95)
    thr = noise_db + max(6.0, min(15.0, (top - noise_db) / 2))
    v = p_db > thr
    return signal.convolve(v.astype(float), np.ones(11), mode="same") > 0 if v.any() else v


def band_power(x, sr, lo, hi, frame=FRAME, hop=HOP):
    sos = signal.butter(4, [lo, min(hi, sr / 2 * 0.95)], "bandpass", fs=sr, output="sos")
    return frame_power(signal.sosfilt(sos, x), sr, frame, hop)


def welch_db(x, sr, nper):
    nper = max(256, min(nper, len(x)))
    f, p = signal.welch(x, sr, nperseg=nper)
    return f, 10 * np.log10(p + 1e-30)


def gather(x, mask, sr):
    """The samples of the frames where mask is true (frames at HOP spacing)."""
    h = int(sr * HOP)
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return np.zeros(0, dtype=x.dtype)
    return np.concatenate([x[i * h: i * h + h] for i in idx])


def hum(x, sr):
    """Mains hum: (50 or 60, prominence in dB of the narrowest peak over its neighbours) or (None, prominence).
    Measured on the whole take: speech harmonics wander, a hum stays on its exact frequency."""
    noise = x
    if len(noise) < sr // 2:
        return None, 0.0
    f, p = welch_db(noise, sr, sr)  # 1 Hz bins
    best = (None, 0.0)
    for base in (50, 60):
        proms = []
        for k in (1, 2, 3):
            i = int(round(base * k / (f[1] - f[0])))
            near = np.r_[p[max(0, i - 12): i - 3], p[i + 4: i + 13]]
            proms.append(p[i - 1: i + 2].max() - np.median(near))
        prom = float(max(proms))
        if prom > best[1]:
            best = (base, prom)
    return best if best[1] >= 10 else (None, round(best[1], 1))


def bandwidth(x, sr):
    """Highest frequency (Hz) the microphone path carries, or None when it is full band.

    A narrowband path (a Bluetooth headset mic at 8, 16 or 24 kHz, resampled by macOS) shows a cliff: the
    spectrum falls 30 dB or more within a few hundred Hz and stays down. Real speech and microphones roll
    off gradually."""
    if len(x) < sr // 4:
        return None
    f, p = welch_db(x, sr, 4096)
    p = signal.medfilt(p, 5)
    step = f[1] - f[0]
    lo, top = int(np.searchsorted(f, 3000)), int(np.searchsorted(f, sr / 2 * 0.85))
    for i in range(lo, top):
        below = np.median(p[max(0, i - int(1500 / step)): i - int(300 / step)])
        above = p[i + int(300 / step): int(np.searchsorted(f, sr / 2 * 0.9))]
        if len(above) and below - above.max() >= 30:
            return float(round(f[i] / 100) * 100)
    return None


def reverb(p_db, noise_db):
    """Rough reverberation time (seconds) from the steepest free decays at speech offsets.

    Speech can't die away faster than the room lets it, so the fastest offset decays approximate the room's
    decay (the idea behind blind RT60 estimators such as Löllmann et al. 2010). Null with too few offsets."""
    fps = 1 / HOP
    sm = np.convolve(p_db, np.ones(3) / 3, mode="same")
    slopes = []
    i, n = 1, len(sm)
    while i < n - 10:
        if sm[i] >= sm[i - 1] and sm[i] > sm[i + 1] and sm[i] > noise_db + 20:
            j = i
            while j + 1 < n and sm[j + 1] < sm[j] + 0.5 and sm[j + 1] > noise_db + 6:
                j += 1
            drop = sm[i] - sm[j]
            if drop >= 8 and j - i >= 4:
                t = np.arange(i, j + 1) / fps
                slopes.append(np.polyfit(t, sm[i: j + 1], 1)[0])
            i = j + 1
        else:
            i += 1
    if len(slopes) < 5:
        return None
    steep = np.percentile(slopes, 10)  # most negative = fastest decays
    return round(float(min(3.0, 60 / -steep)), 2) if steep < 0 else None


def pops(x, sr, noise_low_db, speech_db):
    """Plosive pops (breath hitting the mic): bursts under 100 ms where the energy below 150 Hz jumps far
    above the noise and above the voice band."""
    if speech_db is None:
        return 0
    low = db(frame_power(signal.sosfilt(signal.butter(4, 150, "lowpass", fs=sr, output="sos"), x), sr))
    mid = db(band_power(x, sr, 300, 4000))
    burst = (low > max(noise_low_db, -75) + 25) & (low > mid + 6) & (low > speech_db - 15)
    edges = np.diff(np.r_[0, burst.astype(int), 0])
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    return int(sum(1 for s, e in zip(starts, ends) if e - s <= 10))


def measure(x, sr, room=None):
    """Measurements of a mono float take. room: (start, end) seconds of room tone, if the take had one."""
    x = np.asarray(x, dtype=np.float32)
    n = len(x)
    if n == 0 or float(np.abs(x).max()) == 0.0:
        return {"silent": True, "seconds": round(n / sr, 2) if sr else 0}
    p = frame_power(x - x.mean(), sr)
    p_db = db(p)
    # Frames of digital silence mean something gated the mic (voice processing or a noise gate); they say
    # nothing about the room, so the noise floor comes from the rest.
    gated = p_db < -100
    live = p_db[~gated] if (~gated).sum() > 10 else p_db
    # Minimum statistics: the quietest 10% of frames (5% for short takes with few pauses).
    noise_db = float(np.percentile(live, 10 if n > 5 * sr else 5))
    room_db = None
    if room and room[1] - room[0] >= 0.5:
        a, b = int((room[0] + 0.15) / HOP), int(room[1] / HOP)
        if b > a:
            room_db = float(np.median(p_db[a:b]))
    v = voiced(p_db, noise_db)
    speech_db = float(db(p[v].mean())) if v.any() else None
    snr = round(speech_db - noise_db, 1) if speech_db is not None else None

    a = np.abs(x)
    hot = a >= 0.995
    # Clipping: runs of 3+ samples pinned at full scale (one hot sample is just a loud peak).
    runs = np.diff(np.r_[0, hot.astype(np.int8), 0])
    rs, re_ = np.flatnonzero(runs == 1), np.flatnonzero(runs == -1)
    long_runs = (re_ - rs) >= 3
    clipped = int((re_ - rs)[long_runs].sum())

    quiet = ~v
    noise = gather(x - x.mean(), quiet, sr)
    low_share = None
    if len(noise) > sr // 4:
        f, pn = signal.welch(noise, sr, nperseg=min(len(noise), 8192))
        low_share = round(float(pn[f < 80].sum() / max(pn.sum(), 1e-20)), 3)
    hum_hz, hum_db = hum(x - x.mean(), sr)
    noise_low = db(frame_power(signal.sosfilt(signal.butter(4, 150, "lowpass", fs=sr, output="sos"), noise), sr)) if len(noise) > sr // 10 else np.array([noise_db])

    # Silences inside the reading (between the first and last speech frame).
    idx = np.flatnonzero(v)
    longest = 0.0
    lead = None
    if len(idx):
        lead = round(float(idx[0] * HOP), 2)
        gaps = np.diff(idx)
        longest = round(float(gaps.max() * HOP) if len(gaps) else 0.0, 2)
    return {
        "seconds": round(n / sr, 2),
        "sampleRate": sr,
        "lufs": round(lufs(x, sr), 1),
        "speechDb": round(speech_db, 1) if speech_db is not None else None,
        "noiseDb": round(noise_db, 1),
        "roomDb": round(room_db, 1) if room_db is not None else None,
        "snrDb": snr,
        "peakDb": round(float(db(a.max() ** 2)), 1),
        "clippedPct": round(100 * clipped / n, 3),
        "clipEvents": int(long_runs.sum()),
        "dc": round(float(x.mean()), 5),
        "lowShare": low_share,
        "humHz": hum_hz,
        "humDb": round(hum_db, 1),
        "bandwidthHz": bandwidth(x, sr),
        "gatedPct": round(100 * float(gated.mean()), 1),
        "reverbSec": reverb(p_db, noise_db),
        "pops": pops(x, sr, float(np.median(noise_low)), speech_db),
        "speechPct": round(100 * float(v.mean()), 1),
        "leadSilence": lead,
        "longestPause": longest,
    }


# ------------------------------------------------------------------------------------------- processing

def highpass(x, sr, m):
    """DC, rumble and hum removal (zero phase)."""
    cut = 90.0 if (m.get("lowShare") or 0) > 0.3 else 70.0
    y = signal.sosfiltfilt(signal.butter(4, cut, "highpass", fs=sr, output="sos"), x - x.mean())
    if m.get("humHz"):
        for k in range(1, 5):
            f0 = m["humHz"] * k
            if f0 <= cut * 0.8:
                continue  # the high-pass already removed it
            b, a = signal.iirnotch(f0, 30, sr)
            y = signal.filtfilt(b, a, y)
    return y.astype(np.float32)


def limit(x, sr, ceiling=CEILING):
    """Look-ahead peak limiter: never above `ceiling`, gain changes smoothed over ~5 ms."""
    need = np.minimum(1.0, ceiling / np.maximum(np.abs(x), 1e-9))
    if need.min() >= 1.0:
        return x
    w = max(1, int(sr * 0.005))
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    # min over [t-w, t+w] then average over [t-w/2, t+w/2]: each averaged value is <= need(t).
    g = uniform_filter1d(minimum_filter1d(need, 2 * w + 1), w | 1)
    return (x * np.minimum(g, need)).astype(np.float32)


def gain_to(x, sr, current_db, target_db):
    if current_db is None:
        return x, 0.0
    g = float(np.clip(target_db - current_db, -20.0, MAX_GAIN_DB))
    return limit(x * 10 ** (g / 20), sr), g


def to_rate(x, sr, rate):
    if sr == rate:
        return x.astype(np.float32)
    g = math.gcd(int(sr), int(rate))
    return signal.resample_poly(x, rate // g, sr // g).astype(np.float32)


class Denoiser:
    """DPDFNet-8 48 kHz on ONNX Runtime (CPU). The model is causal and frame-by-frame with a recurrent state;
    a take is cut into chunks that run in parallel, each starting WARM frames early so its state settles."""

    WARM = 300  # frames (3 s)
    CHUNK = 1500

    def __init__(self, path):
        import onnxruntime as ort

        opt = ort.SessionOptions()
        opt.intra_op_num_threads = 1
        opt.inter_op_num_threads = 1
        opt.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.s = ort.InferenceSession(path, sess_options=opt, providers=["CPUExecutionProvider"])
        meta = self.s.get_modelmeta().custom_metadata_map
        self.n_fft = int(meta["n_fft"])
        self.hop = int(meta["hop_length"])
        state = np.zeros(int(meta["state_size"]), np.float32)
        e, sp = int(meta["erb_norm_state_size"]), int(meta["spec_norm_state_size"])
        state[:e] = [float(v) for v in meta["erb_norm_init"].split(",")]
        state[e:e + sp] = [float(v) for v in meta["spec_norm_init"].split(",")]
        self.init = state
        i = np.arange(self.n_fft)
        s = np.sin(0.5 * np.pi * (i + 0.5) / (self.n_fft / 2))
        self.win = np.sin(0.5 * np.pi * s * s).astype(np.float32)  # Vorbis window (power complementary)
        self.names = [x.name for x in self.s.get_inputs()], [x.name for x in self.s.get_outputs()]

    def _stft(self, x):
        n, h = self.n_fft, self.hop
        x = np.pad(x, n // 2, mode="reflect")
        frames = 1 + (len(x) - n) // h
        idx = np.arange(n)[None, :] + h * np.arange(frames)[:, None]
        return np.fft.rfft(x[idx] * self.win, axis=1)

    def _istft(self, spec, length):
        n, h = self.n_fft, self.hop
        frames = np.fft.irfft(spec, n=n, axis=1) * self.win
        out = np.zeros(h * (len(spec) - 1) + n)
        norm = np.zeros_like(out)
        for t in range(len(spec)):
            out[t * h: t * h + n] += frames[t]
            norm[t * h: t * h + n] += self.win ** 2
        out = out / np.maximum(norm, 1e-8)
        return out[n // 2: n // 2 + length]

    def _run(self, spec_ri, a, b):
        (i_spec, i_state), (o_spec, o_state) = self.names
        state = self.init.copy()
        out = np.zeros((b - a, spec_ri.shape[1], 2), np.float32)
        for t in range(max(0, a - self.WARM), b):
            y, state = self.s.run([o_spec, o_state], {i_spec: spec_ri[None, t: t + 1], i_state: state})
            if t >= a:
                out[t - a] = y[0, 0]
        return out

    def __call__(self, x, on_progress=None):
        """48 kHz mono float -> denoised, sample-aligned with the input."""
        n = len(x)
        # The model's output lags its input by two windows; pad the end so the tail comes out too.
        spec = self._stft(np.pad(x, (0, 2 * self.n_fft)).astype(np.float32))
        ri = np.stack([spec.real, spec.imag], -1).astype(np.float32)
        bounds = [(a, min(a + self.CHUNK, len(ri))) for a in range(0, len(ri), self.CHUNK)]
        done, lock = [0], threading.Lock()

        def job(ab):
            r = self._run(ri, *ab)
            with lock:
                done[0] += 1
                if on_progress:
                    on_progress(done[0], len(bounds))
            return r

        # Four workers: about 3x real time on Apple Silicon without taking over the machine.
        with ThreadPoolExecutor(max(1, min(4, (os.cpu_count() or 4) - 2))) as ex:
            parts = list(ex.map(job, bounds))
        e = np.concatenate(parts)
        y = self._istft(e[..., 0] + 1j * e[..., 1], n + 2 * self.n_fft)
        return y[2 * self.n_fft: 2 * self.n_fft + n].astype(np.float32)


def clear_speech(x, sr, noise_db):
    """The louder 40% of speech frames: clearly speech even in a noisy take, where denoising should
    leave the level alone (removing noise 7 dB under them lowers them by under 1 dB)."""
    p = db(frame_power(x, sr))
    v = voiced(p, noise_db)
    if not v.any():
        return v
    return v & (p >= np.percentile(p[v], 60))


def speech_kept(ref, out, sr, mask):
    """(10th percentile, median) level change in dB of `out` against `ref` (300-4000 Hz) on frames in `mask`."""
    if not mask.any():
        return 0.0, 0.0
    a, b = band_power(ref, sr, 300, 4000), band_power(out, sr, 300, 4000)
    m = mask[: min(len(a), len(b))]
    d = db(b[: len(m)][m]) - db(a[: len(m)][m])
    return float(np.percentile(d, 10)), float(np.median(d))


# ------------------------------------------------------------------------------------------- models

_lock = threading.Lock()
_denoiser = None


def denoiser_path(root):
    return os.path.join(root, "enhance", os.path.basename(DENOISER_FILE))


def asr_dir(root):
    return os.path.join(root, "asr-check", ASR_REPO.split("/")[-1])


def models_ready(root):
    return os.path.exists(denoiser_path(root)), os.path.exists(os.path.join(asr_dir(root), "weights.npz")) or \
        os.path.exists(os.path.join(asr_dir(root), "weights.safetensors"))


def download(root):
    """Fetch the denoiser (15 MB) and Whisper base for the check (145 MB) into root."""
    from huggingface_hub import hf_hub_download, snapshot_download

    with _lock:
        have_dn, have_asr = models_ready(root)
        if not have_dn:
            os.makedirs(os.path.join(root, "enhance"), exist_ok=True)
            tmp = os.path.join(root, "enhance", ".hf")
            os.replace(hf_hub_download(DENOISER_REPO, DENOISER_FILE, local_dir=tmp), denoiser_path(root))
            shutil.rmtree(tmp, ignore_errors=True)
        if not have_asr:
            snapshot_download(ASR_REPO, local_dir=asr_dir(root))
    return {"denoiser": denoiser_path(root), "asr": asr_dir(root)}


def get_denoiser(root):
    global _denoiser
    path = denoiser_path(root)
    if _denoiser is None or _denoiser[0] != path:
        _denoiser = (path, Denoiser(path))
    return _denoiser[1]


def asr_score(audio16, text, lang, root):
    """Whisper base's error on `text` (WER for English, character rate otherwise); lower is better."""
    import mlx_whisper
    from zunos_core.scoring import comparable, synth_score

    from .audio import MLX_LOCK

    with MLX_LOCK:
        out = mlx_whisper.transcribe(audio16, path_or_hf_repo=asr_dir(root), language=lang, task="transcribe",
                                     condition_on_previous_text=False, temperature=0.0, verbose=None)
    hyp = out["text"].strip()
    return round(float(synth_score(comparable(hyp, text), text, lang)), 4), hyp


def check_windows(x, sr, lines, marks, read=None, most=8):
    """Up to `most` clip-sized windows of the take with the text read in each: [(start, end, text)].

    Uses segment.py's plan (which also repairs missing or extra marks), so each window is a clip under 30 s:
    Whisper decodes a long take poorly, and one loop or skipped stretch would swamp the comparison."""
    from .segment import pauses, plan, quiet_frames

    if not lines or not marks:
        return []
    try:
        quiet = quiet_frames(x, sr)
        groups = plan(marks, lines, len(x) / sr, pauses(x, sr, quiet), read, quiet)
    except ValueError:
        return []
    wins = [(s, e, " ".join(t.strip() for t in lines[f:l + 1])) for s, e, f, l in groups if e - s >= 1.0]
    if len(wins) > most:
        wins = [wins[round(i * (len(wins) - 1) / (most - 1))] for i in range(most)]
    return wins


def windows_score(audio16, wins, lang, root):
    """Word-weighted error of Whisper base over the windows (audio16 at 16 kHz). Each window's error is capped
    at 1: a decoding loop (base repeating a phrase) would otherwise outweigh every other window."""
    tot = words = 0.0
    for s, e, text in wins:
        sc, _ = asr_score(audio16[int(s * 16000): int(e * 16000)], text, lang, root)
        n = max(1, len(text.split()))
        tot += min(sc, 1.0) * n
        words += n
    return round(tot / words, 4) if words else None


# ------------------------------------------------------------------------------------------- the take

def enhance(path, out, root, lang=None, lines=None, marks=None, room=None, on_progress=None, check_asr=True, windows=None,
            read=None, clips=None, clip_dir=None):
    """Clean the take at `path` into `out` (same rate, 16-bit). Returns {path, raw, clean, strength, ...}.

    `lines`, `marks` and `read` (as for segment) say what was read when, which enables the Whisper check; `room` is the
    (start, end) seconds of room tone at the start of the take. `windows` ([(start, end, text)]) replaces
    lines and marks for the check when the clip boundaries are already known. `clips` ([{id, start, end}], the take's
    clips as segment cut them) are also cut from the cleaned take into `clip_dir`, with each raw clip's
    quality; they come back as "clips": [{id, path, quality}]."""
    import soundfile as sf

    from .audio import to_16k

    step = lambda name, frac: on_progress and on_progress(name, frac)
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    step("measuring", 0.0)
    raw = measure(x, sr, room)
    if raw.get("silent"):
        return {"path": None, "raw": raw, "clean": None, "strength": 0, "applied": False, "reason": "silent"}

    wins = (windows or check_windows(x, sr, lines, marks, read)) if check_asr and lang else []
    have_dn, have_asr = models_ready(root)
    if not have_dn or (wins and not have_asr):
        step("downloading", 0.0)
        download(root)
        have_dn, have_asr = models_ready(root)

    x48 = to_rate(x, sr, RATE)
    pre = highpass(x48, RATE, raw)
    pre, gain = gain_to(pre, RATE, raw["speechDb"], SPEECH_TARGET_DB)
    want = strength_for(raw["snrDb"])
    tried, asr = [], {}
    clear = clear_speech(pre, RATE, raw["noiseDb"] + gain)

    wet = None
    if want > 0:
        step("cleaning", 0.0)
        wet = get_denoiser(root)(pre, lambda d, t: step("cleaning", d / t))

    def mix(limit_db):
        if limit_db <= 0 or wet is None:
            return pre
        a = 10 ** (-limit_db / 20)
        return (a * pre + (1 - a) * wet).astype(np.float32)

    raw_score = None
    can_check = bool(wins and have_asr)
    slack = max(ASR_SLACK, ASR_WORDS / max(1, sum(len(t.split()) for _, _, t in wins)))
    strength, reason = want, "snr" if want > 0 else "clean enough"
    # Candidates: the SNR-based strength, then 8 dB lighter, then none (input conditioning only).
    ladder = [s for s in (want, want - 8) if s >= MIN_LIMIT] + [0.0] if want > 0 else [0.0]
    for s in ladder:
        y = mix(s)
        p10, p50 = speech_kept(pre, y, RATE, clear)
        entry = {"strength": s, "speechKeptDb": round(p10, 2), "speechKeptMedianDb": round(p50, 2)}
        suspect = p10 < -LEVEL_DROP_DB
        ok = s == 0 or p50 >= -LEVEL_HARD_DB
        if ok and s > 0 and (can_check or suspect):
            step("checking", len(tried) / len(ladder))
            sc = None
            try:
                if raw_score is None and can_check:
                    raw_score = windows_score(to_16k(pre, RATE), wins, lang, root)
                    asr = {"raw": raw_score, "windows": len(wins)}
                    if raw_score is None or raw_score > ASR_INFORMATIVE:
                        asr["skipped"] = "uninformative"
                        can_check = False
                if can_check:
                    sc = windows_score(to_16k(y, RATE), wins, lang, root)
            except Exception as e:  # the check is a guardrail, not a requirement: keep the level checks
                print("asr check failed:", e, flush=True)
                can_check = False
            entry["asr"] = sc
            ok = sc <= raw_score + slack if sc is not None else not suspect
        tried.append(entry)
        if ok:
            strength = s
            break
    if strength < want:
        reason = "asr check" if any(t.get("asr") is not None for t in tried) else "speech level"

    y = mix(strength)
    y, _ = gain_to(y, RATE, lufs(y, RATE), OUT_LUFS)
    y = to_rate(y, RATE, sr)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sf.write(out, y, sr, subtype="PCM_16")
    clean = measure(y, sr, room)
    cut = []
    if clips and clip_dir:
        from .segment import clip_quality

        os.makedirs(clip_dir, exist_ok=True)
        for c in clips:
            a, b = int(c["start"] * sr), int(c["end"] * sr)
            p = os.path.join(clip_dir, f"{c['id']}.wav")
            sf.write(p, y[a:b], sr, subtype="PCM_16")
            cut.append({"id": c["id"], "path": p, "quality": clip_quality(x[a:b], sr, raw["noiseDb"])})
    step("done", 1.0)
    return {
        "path": out, "raw": raw, "clean": clean, "strength": strength, "wanted": want, "applied": strength > 0,
        "reason": reason, "gainDb": round(gain, 1), "tried": tried, "asr": asr or None, "model": "dpdfnet8_48khz_hr",
        "clips": cut,
    }
