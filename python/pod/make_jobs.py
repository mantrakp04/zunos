import json, random, subprocess, os, glob
from zunos_core.testset import LEGACY_TEST

random.seed(7)
W = "/workspace/data"
REAL = f"{W}/real/final"
os.makedirs(f"{W}/refs", exist_ok=True)

TEST = LEGACY_TEST

NATIVE_REF = {
    "para-hi-08": "हर सुबह साढ़े छह बजे रमेश अपनी पुरानी साइकिल उठाता है और सब्ज़ी मंडी की तरफ़ निकल पड़ता है। रास्ते में चाय वाला भैया हमेशा आवाज़ लगाता है, और रमेश",
    "para-gu-16": "રોજ સવારે સાત વાગે કવિતા બેન પોતાના ઘરે, પોતાના ઘરની બારી ખોલીને આંગણામાં તુલસીને પાણી આપે છે. પછી તે રસોડામાં જાય છે અને",
    "para-gu-17": "આખા પરિવાર માટે ગરમ ગરમ ચા અને થેપલા બનાવે છે. તેમનો દીકરો જય હજી પણ ઊંઘતો હોય છે, અને તેને ઉઠાડવા માટે",
    "para-gu-20": "બપોરે કવિતા બેન બજાર જાય છે, જ્યાં શાકભાજી વાળો કાકા તેમને જોઈને કહે છે, આવો બેન,",
}
REFS = {
    "cb_en": ["para-en-00", "para-en-01", "para-en-03", "para-en-04"],
    "cb_hi": ["para-hi-08", "para-hi-09", "para-hi-14"],
    "f5_hi": ["para-hi-08", "para-hi-08", "para-gu-17"],
    "f5_gu": ["para-gu-16", "para-gu-17", "para-gu-20", "para-hi-08", "para-gu-16"],
}
assert not (set(sum(REFS.values(), [])) & TEST)

for rid in set(sum(REFS.values(), [])):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{REAL}/48k/{rid}.wav", "-af",
                    "highpass=f=70,afftdn=nf=-28,loudnorm=I=-20:TP=-2:LRA=11", "-ar", "24000", "-ac", "1",
                    f"{W}/refs/{rid}.wav"], check=True)

def lines(path, tsv):
    out = []
    for l in open(path, encoding="utf-8"):
        l = l.strip()
        if not l:
            continue
        if tsv:
            roman, native = l.split("\t")
            out.append((roman.strip(), native.strip()))
        else:
            out.append((l, l))
    return out

C = "/workspace/code/corpus"
en = lines(f"{C}/en1.txt", False) + lines(f"{C}/en2.txt", False)
hi = lines(f"{C}/hi1.tsv", True) + lines(f"{C}/hi2.tsv", True)
gu = lines(f"{C}/gu1.tsv", True) + lines(f"{C}/gu2.tsv", True)

jobs = []
def add(engine, lang, i, k, target, gen_text, ref, **params):
    jobs.append(dict(id=f"{lang}-{i:03d}-{engine}-{k}", engine=engine, lang=lang, target=target, gen_text=gen_text,
                     ref=f"{W}/refs/{ref}.wav", ref_text=NATIVE_REF.get(ref, ""), **params))

def cb_params():
    return dict(exaggeration=round(random.uniform(0.25, 0.95), 2), cfg_weight=round(random.uniform(0.2, 0.7), 2),
                temperature=round(random.uniform(0.7, 1.0), 2))

for i, (t, g) in enumerate(en):
    for k in range(3):
        add("cb_en", "en", i, k, t, g, REFS["cb_en"][(i + k) % 4], **cb_params())
    add("cb_mtl", "en", i, 3, t, g, REFS["cb_en"][(i + 3) % 4], language_id="en", **cb_params())
for i, (t, g) in enumerate(hi):
    for k, ref in enumerate(REFS["f5_hi"]):
        add("f5", "hi", i, k, t, g, ref, speed=round(random.uniform(0.8, 1.2), 2))
    for k in range(2):
        add("cb_mtl", "hi", i, 3 + k, t, g, REFS["cb_hi"][(i + k) % 3], language_id="hi", **cb_params())
for i, (t, g) in enumerate(gu):
    for k, ref in enumerate(REFS["f5_gu"]):
        add("f5", "gu", i, k, t, g, ref, speed=round(random.uniform(0.8, 1.2), 2))

random.shuffle(jobs)
with open(f"{W}/jobs.jsonl", "w", encoding="utf-8") as f:
    for j in jobs:
        f.write(json.dumps(j, ensure_ascii=False) + "\n")
real = [json.loads(l) for l in open(f"{REAL}/transcripts.jsonl")]
for r in real:
    r["split"] = "test" if r["id"] in TEST else "train"
with open(f"{W}/real.jsonl", "w", encoding="utf-8") as f:
    for r in real:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
from collections import Counter
print(Counter(j["engine"] + ":" + j["lang"] for j in jobs), len(jobs))
print(Counter(r["split"] + ":" + r["lang"] for r in real))
