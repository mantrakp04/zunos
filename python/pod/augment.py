import random
import numpy as np, soundfile as sf
from scipy import signal

SR = 16000

def db(x):
    return 10 * np.log10(np.mean(x ** 2) + 1e-12)

class NoiseBank:
    def __init__(self, real_clips, babble_paths):
        self.room = []
        for p in real_clips:
            a, sr = sf.read(p, dtype="float32")
            if a.ndim > 1:
                a = a.mean(1)
            if sr != SR:
                a = signal.resample_poly(a, SR, sr).astype(np.float32)
            frame = 800
            n = len(a) // frame
            if n < 10:
                continue
            f = a[: n * frame].reshape(n, frame)
            e = (f ** 2).mean(1)
            quiet = f[e <= np.quantile(e, 0.15)]
            if len(quiet):
                self.room.append(quiet.reshape(-1))
        self.babble_paths = babble_paths

    def colored(self, n):
        w = np.random.randn(n).astype(np.float32)
        kind = random.choice(["white", "pink", "brown", "hum", "fan"])
        if kind == "pink":
            b, a = [0.049922035, -0.095993537, 0.050612699, -0.004408786], [1, -2.494956002, 2.017265875, -0.522189400]
            w = signal.lfilter(b, a, w)
        elif kind == "brown":
            w = np.cumsum(w)
            w = w - signal.lfilter([1], [1, -0.995], w)
        elif kind == "hum":
            t = np.arange(n) / SR
            f0 = random.choice([50, 60])
            w = sum(np.sin(2 * np.pi * f0 * k * t + random.random() * 6) / k for k in range(1, 6)) + 0.05 * w
        elif kind == "fan":
            w = signal.lfilter(*signal.butter(2, random.uniform(300, 1500) / (SR / 2)), w)
        return w.astype(np.float32)

    def babble(self, n):
        out = np.zeros(n, np.float32)
        for p in random.sample(self.babble_paths, k=min(len(self.babble_paths), random.randint(3, 6))):
            a, _ = sf.read(p, dtype="float32")
            if len(a) < n:
                a = np.tile(a, n // max(len(a), 1) + 1)
            s = random.randint(0, len(a) - n)
            seg = a[s:s + n]
            out += seg / (np.sqrt(np.mean(seg ** 2)) + 1e-6)
        return out

    def room_noise(self, n):
        a = random.choice(self.room)
        if len(a) < n:
            a = np.tile(a, n // len(a) + 1)
        s = random.randint(0, len(a) - n)
        return a[s:s + n].copy()

    def sample(self, n):
        r = random.random()
        if r < 0.35 and self.room:
            return self.room_noise(n)
        if r < 0.65:
            return self.babble(n)
        return self.colored(n)

def add_noise(x, noise, snr):
    noise = noise[: len(x)]
    gain = 10 ** ((db(x) - db(noise) - snr) / 20)
    return x + noise * gain

def speed(x, f):
    up, down = 100, int(round(100 * f))
    return signal.resample_poly(x, up, down).astype(np.float32)

def rir():
    rt60 = random.uniform(0.15, 0.8)
    n = int(rt60 * SR)
    t = np.arange(n) / SR
    h = np.random.randn(n) * np.exp(-6.9 * t / rt60)
    h[0] = random.uniform(2, 6)
    h = signal.lfilter(*signal.butter(1, random.uniform(3000, 7500) / (SR / 2)), h)
    return (h / np.sqrt(np.sum(h ** 2))).astype(np.float32)

def reverb(x):
    y = signal.fftconvolve(x, rir())[: len(x)]
    return (y * (np.abs(x).max() / (np.abs(y).max() + 1e-6))).astype(np.float32)

def channel(x):
    kind = random.choice(["phone", "bluetooth", "lowpass", "mulaw", "cheapmic"])
    if kind == "phone":
        y = signal.resample_poly(x, 1, 2)
        y = signal.lfilter(*signal.butter(4, [300 / 4000, 3400 / 4000], "band"), y)
        return signal.resample_poly(y, 2, 1).astype(np.float32)
    if kind == "bluetooth":
        y = signal.resample_poly(x, 1, 2)
        y = np.round(y * 2 ** 9) / 2 ** 9
        return signal.resample_poly(y, 2, 1).astype(np.float32)
    if kind == "lowpass":
        return signal.lfilter(*signal.butter(4, random.uniform(2500, 5000) / (SR / 2)), x).astype(np.float32)
    if kind == "mulaw":
        mu = 255
        y = np.sign(x) * np.log1p(mu * np.abs(np.clip(x, -1, 1))) / np.log1p(mu)
        y = np.round(y * 127) / 127
        return (np.sign(y) * ((1 + mu) ** np.abs(y) - 1) / mu).astype(np.float32)
    b = signal.firwin(31, [random.uniform(100, 300), random.uniform(3000, 6000)], pass_zero=False, fs=SR)
    return signal.lfilter(b, 1, x).astype(np.float32)

def slur(x):
    hop = random.randint(int(0.12 * SR), int(0.3 * SR))
    parts = []
    for s in range(0, len(x), hop):
        seg = x[s:s + hop]
        if len(seg) < 400:
            parts.append(seg)
            continue
        f = random.uniform(0.75, 1.15)
        seg = signal.resample(seg, int(len(seg) * f)).astype(np.float32) if f != 1 else seg
        if random.random() < 0.08:
            k = random.randint(160, 900)
            z = random.randint(0, max(1, len(seg) - k))
            seg = seg.copy()
            seg[z:z + k] *= random.uniform(0, 0.3)
        parts.append(seg)
    fade = 80
    y = parts[0]
    for p in parts[1:]:
        if len(y) > fade and len(p) > fade:
            w = np.linspace(0, 1, fade, dtype=np.float32)
            y = np.concatenate([y[:-fade], y[-fade:] * (1 - w) + p[:fade] * w, p[fade:]])
        else:
            y = np.concatenate([y, p])
    y = signal.lfilter(*signal.butter(3, random.uniform(2200, 4200) / (SR / 2)), y)
    return y.astype(np.float32)

def augment(x, bank, real=False):
    x = x.astype(np.float32)
    p = 0.5 if real else 1.0
    if random.random() < 0.15 * p:
        x = slur(x)
    if random.random() < 0.5 * p:
        x = speed(x, random.uniform(0.85, 1.2))
    if random.random() < 0.3 * p:
        x = reverb(x)
    if not real and bank.room and random.random() < 0.55:
        x = add_noise(x, bank.room_noise(len(x)), random.uniform(4, 16))
    if random.random() < 0.45 * p:
        x = add_noise(x, bank.sample(len(x)), random.uniform(0, 25))
    if random.random() < 0.25 * p:
        x = channel(x)
    g = 10 ** (random.uniform(-25, 3) / 20)
    x = x / (np.abs(x).max() + 1e-6) * g
    if random.random() < 0.03:
        x = np.clip(x * random.uniform(2, 6), -1, 1)
    return x.astype(np.float32)
