"""Fast checks of the pod pipeline's pure parts (no models, no GPU):

    cd python/pod && python -m pytest -q tests      (or: python tests/test_pipeline.py)

The full path (generation, judging, training, report) is exercised by `python run.py --dry-run`.
"""
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import config  # noqa: E402
import corpus  # noqa: E402
import data  # noqa: E402
import pace  # noqa: E402
from tempo import tempo  # noqa: E402
from zunos_core.scoring import bootstrap, comparable, verdict  # noqa: E402


def test_tempo_keeps_pitch_and_sets_length():
    sr = 16000
    t = np.arange(2 * sr) / sr
    x = np.sin(2 * np.pi * 180 * t).astype(np.float32)
    for rate in (0.6, 1.3):
        y = tempo(x, rate, sr)
        assert abs(len(y) - len(x) / rate) < sr * 0.01
        f0 = np.argmax(np.abs(np.fft.rfft(y * np.hanning(len(y))))) * sr / len(y)
        assert abs(f0 - 180) < 2


def test_bootstrap_ratio_and_verdict():
    ours = [dict(id=f"c{i}", lang="hi", wer=0.1, words=10) for i in range(10)]
    ref = [dict(id=f"c{i}", lang="hi", wer=0.3, words=10) for i in range(10)]
    s = bootstrap(ours, ref, n=200)["hi"]
    assert s["wer"] == 0.1 and s["other"] == 0.3 and s["ratio"] == 3.0 and verdict(s) == "pass"
    assert verdict(bootstrap(ours, None, n=50)["hi"]) == "n/a"


def test_reference_text_is_romanized_for_romanized_keys():
    assert comparable("कमल", "kamal") == "kamal"
    assert comparable("hello", "hello") == "hello"


def test_test_guard_blocks_overlap():
    clips = [dict(id="t1", lang="hi", split="test", text="main kal subah station jaunga")]
    g = corpus.TestGuard(clips)
    assert not g.ok("haan main kal subah station jaunga yaar", "hi")
    assert g.ok("aaj shaam ko bazaar chalenge", "hi")


def test_dev_split_is_stable_and_leaves_enough_train():
    clips = [dict(id=f"c{i}", lang="en", split="train") for i in range(20)] + [dict(id="t", lang="en", split="test")]
    a = data.assign(clips, {"real_per_lang": 3, "min_train_left": 12})
    b = data.assign(clips, {"real_per_lang": 3, "min_train_left": 12})
    assert [c["split"] for c in a] == [c["split"] for c in b]
    assert sum(c["split"] == "dev" for c in a) == 3 and a[-1]["split"] == "test"
    assert sum(c["split"] == "dev" for c in data.assign(clips[:10], {"real_per_lang": 3, "min_train_left": 12})) == 0


def test_variants_resolve_and_validate():
    cfg = config.load({"variants": [{"name": "a"}, {"name": "b", "method": "lora", "stage2": {"steps": 0}}]})
    assert cfg["runs"][1]["method"] == "lora" and cfg["runs"][1]["stage2"]["lr_mult"] == 0.2
    assert cfg["runs"][0]["stage2"]["steps"] == 120
    try:
        config.load({"variants": [{"name": "a"}, {"name": "a"}]})
        raise AssertionError("duplicate names accepted")
    except ValueError:
        pass
    gen = config.merge(config.GEN, {"engines": {"gu": ["vc"]}, "vc": {"tts": {"gu": "higgs"}}})
    assert config.tts_engines(gen, ["en", "gu"]) == {"omnivoice", "higgs"}


def test_pace_factor_range():
    rng = random.Random(0)
    p = config.GEN["pace"]
    fs = [pace.factor(rng, p) for _ in range(500)]
    assert min(fs) >= p["slow"] and max(fs) <= p["rushed"] and 0.9 < float(np.median(fs)) < 1.1


def test_variability_plan_keeps_words_and_caps_inpainting():
    import variability

    rng = random.Random(1)
    n_eff, n_edit = 0, 0
    for _ in range(400):
        p = variability.plan(rng, "hi", "वहाँ बहुत भीड़ थी इसलिए हम जल्दी वापस आ गए।", {})
        assert len(p["effects"]) <= 2
        n_eff += bool(p["effects"])
        n_edit += bool(p["edits"])
        for e in p["effects"]:
            assert 0 < e["at"] < 1
    assert 0.3 < n_eff / 400 < 0.75 and 0.1 < n_edit / 400 < 0.5
    en = variability.reduce_text(random.Random(0), "en", "I'm going to call because I probably need it", 1.0)
    assert "[G AH1 N AH0]" in en and "[K AH0 Z]" in en
    assert variability.plan(rng, "en", "a b c", {"enabled": False})["tts_text"] == "a b c"


def test_deletion_check():
    from judge import deleted_words

    assert deleted_words("call the bank", "call the bank tomorrow", "en") == ["tomorov"]
    assert deleted_words("ame gharethi aavya", "ame ghare thi aavya", "gu") == []


def test_pace_clip_per_language():
    rng = random.Random(0)
    p = config.GEN["pace"]
    en = [pace.factor(rng, dict(p, sigma=2.0), "en") for _ in range(300)]
    hi = [pace.factor(rng, dict(p, sigma=2.0), "hi") for _ in range(300)]
    assert min(en) == 0.6 and max(en) == 1.5 and min(hi) == 0.7 and max(hi) == 1.4


def test_pseudo_guards_and_segments():
    import pseudo

    tests = [dict(id="t1", lang="gu", text="Khatla upar suta ta. Emni bajuma ek khurshi hati.")]
    assert pseudo.overlaps_test("ane khatla upar suta ta, emni bajuma ek khurshi hati ane", tests, "gu") == "t1"
    assert pseudo.overlaps_test("Maharaj aavya chhe, leva mate aavya chhe", tests, "gu") is None
    pseudo.check_spans([dict(id="u", source="s", span=[0, 1940])], [dict(id="c", source="s", span=[1951, 1960])])
    try:
        pseudo.check_spans([dict(id="u", source="s", span=[1900, 2000])], [dict(id="c", source="s", span=[1951, 1960])])
        raise AssertionError("an overlapping span passed")
    except AssertionError as e:
        assert "overlaps" in str(e)
    sr = pseudo.SR
    segs = pseudo.merge_regions([(0, 3 * sr), (int(3.5 * sr), 6 * sr), (10 * sr, 11 * sr), (30 * sr, 52 * sr)], 4, 20, 0.8, 0.0, 60 * sr)
    assert segs == [(0, 6 * sr)]  # the 1 s region is too short, the 22 s one too long


def test_variant_options_validated():
    spec = {"pseudo": {"p1": {"teacher": "a"}}, "variants": [{"name": "s", "pseudo": {"set": "p1"}}, {"name": "a"}]}
    for bad in (spec, {"variants": [{"name": "x", "select": "dev", "dev_clips": "train"}]}):
        try:
            config.load(bad)
            raise AssertionError("accepted")
        except ValueError:
            pass
    cfg = config.load({"pseudo": {"p1": {"teacher": "a"}}, "variants": [{"name": "a"}, {"name": "s", "pseudo": {"set": "p1"}}]})
    assert cfg["pseudo"]["p1"]["vad"]["max_s"] == 20.0 and cfg["runs"][0]["kl"]["weight"] == 0.0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
