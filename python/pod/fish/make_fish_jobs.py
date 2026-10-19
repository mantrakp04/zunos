import json, random, subprocess, os

random.seed(11)
W = "/workspace/data"
REAL = f"{W}/real/final"
os.makedirs(f"{W}/refs_fish", exist_ok=True)

NATIVE = {
    "para-hi-08": "हर सुबह साढ़े छह बजे रमेश अपनी पुरानी साइकिल उठाता है और सब्ज़ी मंडी की तरफ़ निकल पड़ता है। रास्ते में चाय वाला भैया हमेशा आवाज़ लगाता है, और रमेश",
    "para-hi-09": "बिना रुके हाथ हिला कर आगे बढ़ जाता है। मंडी में भीड़ इतनी होती है कि पैर रखने की जगह नहीं मिलती, फिर भी सब लोग हँस हँस कर मोल भाव करते रहते हैं। आज टमाटर चालीस रुपये किलो है, प्याज़ पच्चीस के, और धनिया तो मुफ़्त में ही मिल रही है अगर आप",
    "para-hi-14": "रमेश मुस्कुराया, चाय पी, और जब बादल छटे तब धीरे धीरे घर की तरफ़ चल दिया। घर पहुँच कर पता चला कि मेहमान पहले ही आ चुके थे और माँ ने जल्दी जल्दी दाल चावल बना दिए थे। सबने मिलकर खाया, पुरानी बातें याद कीं, और देर रात तक हँसते रहे,",
    "para-gu-16": "રોજ સવારે સાત વાગે કવિતા બેન પોતાના ઘરે, પોતાના ઘરની બારી ખોલીને આંગણામાં તુલસીને પાણી આપે છે. પછી તે રસોડામાં જાય છે અને",
    "para-gu-17": "આખા પરિવાર માટે ગરમ ગરમ ચા અને થેપલા બનાવે છે. તેમનો દીકરો જય હજી પણ ઊંઘતો હોય છે, અને તેને ઉઠાડવા માટે",
    "para-gu-20": "બપોરે કવિતા બેન બજાર જાય છે, જ્યાં શાકભાજી વાળો કાકા તેમને જોઈને કહે છે, આવો બેન,",
    "para-gu-21": "આજે ભીંડા તાજા છે. તે બે કિલો બટાકા, એક કિલો ટામેટા, અને થોડી કોથમીર લે છે, અને હંમેશની જેમ ભાવમાં થોડી રકઝક કરે છે. ઘરે પાછા આવીને તે",
}
real = {json.loads(l)["id"]: json.loads(l) for l in open(f"{REAL}/transcripts.jsonl")}
REFS = {"en": ["para-en-00", "para-en-01", "para-en-03", "para-en-04"],
        "hi": ["para-hi-08", "para-hi-09", "para-hi-14"],
        "gu": ["para-gu-16", "para-gu-17", "para-gu-20", "para-gu-21"]}
for lang, ids in REFS.items():
    for rid in ids:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{REAL}/48k/{rid}.wav", "-af", "loudnorm=I=-20:TP=-2:LRA=11",
                        "-ar", "44100", "-ac", "1", f"{W}/refs_fish/{rid}.wav"], check=True)

STYLES = ["[drunk, slurring the words]", "[half asleep, mumbling]", "[tired, speaking slowly]", "[out of breath, walking fast]",
          "[whispering]", "[talking fast, excited]", "[annoyed, rushing]", "[laughing while talking]", "[mouth full, chewing]",
          "[sick with a cold, nasal]", "[distracted, trailing off]", "[very drunk, words running together]"]

def lines(path, tsv):
    out = []
    for l in open(path, encoding="utf-8"):
        l = l.strip()
        if l:
            out.append(tuple(x.strip() for x in l.split("\t")) if tsv else (l, l))
    return out

C = "/workspace/code/corpus"
corp = {"en": lines(f"{C}/en1.txt", False) + lines(f"{C}/en2.txt", False),
        "hi": lines(f"{C}/hi1.tsv", True) + lines(f"{C}/hi2.tsv", True),
        "gu": lines(f"{C}/gu1.tsv", True) + lines(f"{C}/gu2.tsv", True)}
jobs = []
for lang, rows in corp.items():
    for i, (target, native) in enumerate(rows):
        for k in range(2):
            rid = REFS[lang][(i + k) % len(REFS[lang])]
            style = random.choice(STYLES) if k == 1 else ""
            jobs.append(dict(id=f"{lang}-{i:03d}-fish-{k}", engine="fish", lang=lang, target=target,
                             gen_text=(style + " " + native).strip(), plain_text=native, style=style,
                             ref=f"{W}/refs_fish/{rid}.wav", ref_text=NATIVE.get(rid, real[rid]["text"])))
random.shuffle(jobs)
with open(f"{W}/fish_jobs.jsonl", "w", encoding="utf-8") as f:
    for j in jobs:
        f.write(json.dumps(j, ensure_ascii=False) + "\n")
existing = {json.loads(l)["id"] for l in open(f"{W}/jobs.jsonl", encoding="utf-8")}
with open(f"{W}/jobs.jsonl", "a", encoding="utf-8") as f:
    for j in jobs:
        if j["id"] not in existing:
            f.write(json.dumps(dict(j, gen_text=j["plain_text"]), ensure_ascii=False) + "\n")
print(len(jobs), "fish jobs")
