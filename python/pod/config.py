"""Experiment configuration: one spec, many variants, every variant scored the same way.

A spec is JSON (the dataset manifest's `cfg`, or a file passed to run.py --spec). Shape:

  {
    "name": "first-gpu-session",
    "gen":   {...},                 # how synthetic speech is made (shared by all variants)
    "judge": {...},                 # how synthetic takes are filtered (shared)
    "train": {...},                 # training defaults
    "export": "<variant name>",     # the variant whose model is uploaded (default: the first)
    "pseudo": {"<set>": {...}},     # pseudo-labeled sets made from unlabeled audio (pseudo.py); variants use one
    "keep_going": false,            # true: a failed variant (or pseudo set) is logged and the run continues
    "variants": [                   # each one is a deep merge over "train" (and may narrow `synth`)
      {"name": "whisper-full"},
      {"name": "whisper-lora", "method": "lora"},
    ]
  }

An empty spec (what the app sends) is the single production recipe. Every key has a default below, so a
spec only names what it changes. Generation and filtering run once per distinct (gen, judge) setting and
are cached by content hash (cache.py), so variants never regenerate audio.
"""
import copy
import hashlib
import json

# How each language's synthetic speech is made. `engines` maps a language (or "default") to the list of
# generation paths to run for it; each path writes its own takes, and variants pick among them (`synth`).
#   omnivoice   zero-shot cloning of the user's voice (k2-fsa/OmniVoice)
#   higgs       zero-shot cloning with Higgs TTS 3 (needs a CUDA >= 13.0 host; research / non-commercial license,
#               fine for the owner's own model, not for anything sold)
#   vc          TTS in the voice that reads the language best, then voice conversion to the user (vc.py)
#   say         macOS `say`, for the local dry run only
# A path may name where its voice references come from: "omnivoice@hi" clones from the user's Hindi clips.
GEN = {
    "engines": {"default": ["omnivoice"]},
    "takes": 1,                       # one take per sentence; references rotate across sentences
    "max_lines_per_lang": 0,          # 0 = the whole corpus
    "include_prompts": True,          # also read the dataset's built-in sentences (deduplicated)
    # Voice references: the user's train clips of `min_s`-`max_s` (<= 10 s clones best). `from` makes a
    # language take its references from another of the user's languages ({"gu": "hi"}: the study found
    # Gujarati clones far from the user's voice; Hindi references may clone it better).
    "refs": {"per_lang": 32, "min_s": 3.0, "max_s": 10.0, "borrow": True, "from": {}},
    # Pace: target letters/second = the user's measured rate per language x a factor drawn from a log-normal
    # around `center`, clipped to [slow, rushed] (per language in by_lang). Below 1 is slower than the user.
    "pace": {"center": 1.0, "sigma": 0.2, "slow": 0.7, "rushed": 1.4, "by_lang": {"en": {"slow": 0.6, "rushed": 1.5}}},
    "omnivoice": {"num_step": 32, "guidance_scale": 2.0, "batch": 8, "inpaint_steps": 16},
    "higgs": {"port": 30000},
    # TTS+VC: the TTS reads the language in a voice it reads well, not the user's: voices[lang] is a list of
    # {audio, text} native-speaker references (paths on the pod) or {instruct} voice descriptions; without one
    # the engine uses its own default voice. vc.py then converts each take to a rotating user reference.
    # `tts` may be per language: {"gu": "higgs", "default": "omnivoice"}.
    "vc": {"tts": "omnivoice", "model": "seed-vc", "voices": {}, "diffusion_steps": 30, "cfg_rate": 0.7},
    # Per-take speaking-style variation (variability.py): inpainted rush/drag/pause/mumble, respellings,
    # fillers, repeats, denoise off. Labels stay the clean sentence.
    "variability": {"enabled": True},
}

# Which recognizer judges a take for a language, and how strict the filter is. The words threshold is relative
# to the judge's error on the shard's CLEAN takes (no edits, no inpainting; the judge's floor on this TTS):
#   error <= max(abs_floor, clean_median * ceiling_mult + max_err)
# (the error on the user's real clips is reported too, but it is 0.25-0.33 and let 3-word deletions through).
# Any label word missing from the hypothesis rejects a take (deletions). Disfluent takes are scored against
# both the label and what the TTS read, keeping the lower error.
JUDGE = {
    "models": {"en": "whisper", "indic": "indicconformer", "default": "whisper", "longtail": []},
    "indic_langs": ["as", "bn", "gu", "hi", "kn", "ml", "mr", "ne", "or", "pa", "sa", "ta", "te", "ur"],
    "max_err": 0.10, "ceiling_mult": 1.0, "abs_floor": 0.05,
    "deletions": True,
    "phoneme": False,                         # also require a phoneme-level match (espeak-ng)
    # Voice: cosine to the user's centroid >= max(abs_min, min(min_rel x real-vs-real, shard median - mad_k x MAD)).
    # The second term calibrates per shard: Gujarati clones sat at 0.44 vs a 0.77 real-vs-real ceiling, so a
    # fixed relative bar rejected every take; now only the shard's outliers go.
    "speaker": {"enabled": True, "min_rel": 0.75, "mad_k": 3.0, "abs_min": 0.25},
    "pace": {"enabled": True, "slack": 0.25},        # letters/s within the requested pace +-25%
    "whisper_model": "openai/whisper-large-v3",
}

TRAIN = {
    # whisper-large-v3 | whisper-large-v3-turbo | qwen3-asr-1.7b | flex (bodhan-ai/indic-transcribe-flex) | <hf id>
    "base": "whisper-large-v3",
    "method": "full",                 # full | lora
    # targets: attn | attn+mlp | enc, enc+mlp (flex: encoder attention / + feed-forward only; the decoder stays the
    # base's) | a regex
    "lora": {"r": 32, "alpha": 64, "dropout": 0.05, "targets": "attn+mlp"},
    "lr": 1e-5, "lora_lr": 2e-4, "bs": 16, "accum": 2, "gc": 1, "warmup": 0.08, "weight_decay": 0.01,
    "freeze_enc": 0,                  # Whisper: first N encoder layers; Qwen/flex: >0 freezes the encoder
    # Stage 1: synthetic + real, real oversampled so it is `real_share` of the samples seen.
    "stage1": {"epochs": 3, "steps": 0, "real_share": 0.3},   # steps > 0 overrides epochs
    # Stage 2: short real-only polish at lr x lr_mult (0 steps = off). Before 2026-10-19 lr_mult was ignored and stage 2
    # ran at the full lr; lr_mult 1.0 reproduces that.
    "stage2": {"steps": 120, "lr_mult": 0.2, "augment": 0.5},
    "synth": {"share": 1.0, "engines": None},   # fraction of the kept synthetic takes; engines per language
    "augment": True, "concat": 0.25,
    "variability": {"enabled": False},  # training-time audio hook (variability.perturb); none adopted yet
    # Staying close to the base model (flex only for now): weight x KL(base || model) on the label tokens, the
    # frozen base's token distributions on the same batches (LoRA: the adapters switched off), at temperature `temp`.
    "kl": {"weight": 0.0, "temp": 1.0},
    "select": "last",                 # last = fixed recipe; dev = best dev score (never the test clips)
    "eval_every": 100,
    "patience": 0,                    # select=dev: stop after this many evals without a better dev score (0 = never)
    "dev_beams": 1,
    # The real dev clips (spec "dev"): "holdout" keeps them out of training (needed for select=dev); "train" trains
    # on them, so a variant that doesn't select on dev loses no data when another variant of the run does.
    "dev_clips": "holdout",
    # Pseudo-labeled audio (a set named in the spec's "pseudo"), mixed into stage 1 like synthetic takes, the real
    # clips oversampled to stage1.real_share; `share` = fraction of the set's kept segments used.
    "pseudo": {"set": None, "share": 1.0},
    "probe_train": 0,                 # after the test: also decode this many train clips (memorization probe)
    "beams": 4,                       # final test decode, as on the Mac
    "workers": 8,
    "seed": 0,
}

# One pseudo-labeled set (pseudo.py): the user's unlabeled audio (dataset unlabeled/, e.g. everyday dictation) cut
# into speech segments, kept when it is the user's voice, labeled by a teacher and kept only where a second model
# agrees. teacher / agree: a variant of this run (trained before the first variant that uses the set) or a model
# spec (a base such as "flex", or a model folder). teacher "provided": the labels come with the audio (each unlabeled
# entry is one segment with its `text`, e.g. the reference's transcript of a dictation); no VAD, no teacher decode.
PSEUDO = {
    "teacher": None,
    "agree": None,                    # None = no agreement check
    "max_disagree": 0.25,             # fuzzy WER between the teacher's and the agreeing model's text; None = report only
    "beams": 4, "agree_beams": 2,
    # silero-vad speech regions, merged across gaps <= max_gap into segments of min_s..max_s seconds.
    "vad": {"threshold": 0.5, "min_s": 4.0, "max_s": 20.0, "max_gap": 0.8, "pad": 0.15},
    # Voice: cosine to the centroid of the user's labeled train clips >= max(abs_min, min_rel x real-vs-real).
    "speaker": {"enabled": True, "min_rel": 0.85, "abs_min": 0.5},
    # Sanity: letters/s of the teacher's text within [cps_lo, cps_hi] x the user's median on labeled train
    # clips; at most max_repeat of its word trigrams repeated (loops).
    "cps_lo": 0.5, "cps_hi": 1.6, "max_repeat": 0.15,
    "max_minutes": 0,                 # cap on the segmented audio decoded (0 = all)
}

DEFAULTS = {"name": "default", "gen": GEN, "judge": JUDGE, "train": TRAIN, "variants": [{"name": "default"}],
            "pseudo": {}, "keep_going": False,
            # Real clips held out of training to pick checkpoints (select=dev). Never the test clips.
            "dev": {"real_per_lang": 0, "min_train_left": 12, "synth_frac": 0.04}}


def merge(base, over):
    """Deep merge: dicts merge key by key, everything else is replaced."""
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def load(spec):
    """The full config for a spec (dict or None). Variants come back fully resolved under cfg["runs"]."""
    cfg = merge(DEFAULTS, {k: v for k, v in (spec or {}).items() if k != "variants"})
    variants = (spec or {}).get("variants") or [{"name": "default"}]
    names = [v.get("name") for v in variants]
    if len(set(names)) != len(names) or not all(names):
        raise ValueError(f"every variant needs a unique name, got {names}")
    cfg["runs"] = [dict(merge(cfg["train"], dict(v)), name=v["name"]) for v in variants]
    cfg["pseudo"] = {k: merge(PSEUDO, v) for k, v in cfg["pseudo"].items()}
    for r in cfg["runs"]:
        if r["select"] == "dev" and r["dev_clips"] != "holdout":
            raise ValueError(f"{r['name']}: select=dev needs dev_clips=holdout")
        ps = r["pseudo"]["set"]
        if ps:
            if ps not in cfg["pseudo"]:
                raise ValueError(f"{r['name']}: no pseudo set {ps!r} in the spec")
            for role in ("teacher", "agree"):
                m = cfg["pseudo"][ps][role]
                if m in names and names.index(m) >= names.index(r["name"]):
                    raise ValueError(f"{r['name']}: pseudo set {ps!r} {role} {m!r} must be a variant trained before it")
            if not cfg["pseudo"][ps]["teacher"]:
                raise ValueError(f"pseudo set {ps!r} needs a teacher")
        if r["method"] not in ("full", "lora"):
            raise ValueError(f"{r['name']}: method must be full or lora")
        if r["select"] not in ("last", "dev"):
            raise ValueError(f"{r['name']}: select must be last or dev")
    if cfg.get("export") and cfg["export"] not in names:
        raise ValueError(f"export names no variant: {cfg['export']}")
    return cfg


def engines_for(gen, lang):
    return list(gen["engines"].get(lang, gen["engines"].get("default", [])))


def base_engine(name):
    """A generation path's engine: "omnivoice@hi" is OmniVoice with references taken from the user's Hindi."""
    return name.split("@", 1)[0]


def vc_tts(gen, lang):
    """The TTS that reads a language for TTS+VC: gen.vc.tts is an engine name or {lang | "default": name}."""
    t = gen["vc"]["tts"]
    return t.get(lang, t.get("default", "omnivoice")) if isinstance(t, dict) else t


def tts_engines(gen, langs):
    """Every TTS engine a set of languages needs, direct cloning and the TTS half of TTS+VC."""
    out = set()
    for l in langs:
        for e in map(base_engine, engines_for(gen, l)):
            out.add(vc_tts(gen, l) if e == "vc" else e)
    return out


def digest(*parts, n=16):
    """Stable short hash of JSON-able parts (dict key order doesn't matter)."""
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:n]
