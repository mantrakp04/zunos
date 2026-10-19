import json, collections, statistics as st
from textnorm import roman_cer
P = "/workspace/data/synth_scored.jsonl"
rows = {}
for l in open(P, encoding="utf-8"):
    r = json.loads(l); rows[r["id"]] = r
for r in rows.values():
    if r["lang"] != "en":
        r["score_native"] = r.get("score_native", r["score"])
        r["score"] = round(roman_cer(r["hyp"], r["text"]), 3)
with open(P + ".tmp", "w", encoding="utf-8") as f:
    for r in rows.values(): f.write(json.dumps(r, ensure_ascii=False) + "\n")
import os; os.replace(P + ".tmp", P)
for lang in ["hi", "gu"]:
    g = [r for r in rows.values() if r["lang"] == lang]
    by = collections.defaultdict(list)
    for r in g: by[r["id"].split("-")[-2] + r["id"].split("-")[-1]].append(r["score"])
    print(lang, "median", st.median(r["score"] for r in g), {k: (round(st.median(v), 2), len(v)) for k, v in sorted(by.items())})
    for t in [0.25, 0.3, 0.35, 0.4]: print("  <=", t, sum(r["score"] <= t for r in g), "/", len(g))
