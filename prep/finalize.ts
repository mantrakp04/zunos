import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "/Users/barreloflube/voice-data/data";
const segs: Record<string, any> = Object.fromEntries(JSON.parse(readFileSync(`${DIR}/segments.json`, "utf8")).map((s: any) => [s.id, s]));
const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8"));

const final: [string[], string, boolean?][] = [
  [["para-en-00"], "Every morning at a quarter past six, Meera unlocks the small clinic on Station Road and switches on the old radio by the window. The first patient is usually Mr. Desai, who is seventy-two,"],
  [["para-en-01"], "walks with a carved wooden stick, and insists that his blood pressure is perfectly fine. It never is, of course, but he also likes to argue about it while she wraps the cuff around his arm"],
  [["para-en-02"], "counts quietly under her breath. By eight o'clock the waiting room is full, a carpenter with bandaged thumb, two schoolgirls with fever, and young father holding twins who refuse to stop crying."],
  [["para-en-03"], "Meera keeps a notebook with everyone's name, the medicine, and the date of the next visit, because the computer crashes whenever it rains. Last"],
  [["para-en-04"], "Thursday the power went out for almost three hours, and the doctor had to write fourteen prescriptions by hand, squinting at her torch. Nobody complained. The carpenter fixed the broken hinge on the cupboard,"],
  [["para-en-05"], "the twins finally fell asleep, and Mr. Desai brought everyone a box of sweets from the market. Around noon the rush slows down, and Meera eats a lunch of rice, dal and"],
  [["para-en-06", "para-en-07"], "pickled mango while reading a newspaper backwards, starting with the crossword. In the afternoon she phones patients who missed their appointments, reminds them gently, and books new slot for Monday, Wednesday, or Friday. Some people answer on the first ring, others call back late at night, apologising, asking whether the doctor can see them, whether the doctor can see them tomorrow. She always says yes, and even when the diary is already full, because she knows", true],
  [["para-en-08"], "some of them travel just to get here. When the clinic finally closes at seven, she counts the cash, cash twice, waters the plants on the balcony, and switches off the radio, which has been playing the same song all day."],
  [["para-hi-00"], "Har subah saade chhe baje Ramesh apni purani cycle uthata hai aur sabzi mandi ki taraf nikal padta hai. Raaste mein chai wala bhaiya hamesha awaaz lagata hai, aur Ramesh"],
  [["para-hi-01", "para-hi-02"], "bina ruke haath hila kar aage badh jaata hai. Mandi mein bheed itni hoti hai ki pair rakhne ki jagah nahi milti, phir bhi sab log hans hans kar mol bhaav karte rehte hain. Aaj tamatar chaalis rupaye kilo hai, pyaaz pachchees ke, aur dhaniya toh muft mein hi mil rahi hai agar aap"],
  [["para-hi-03"], "do kilo le leta hoon. Ramesh ki maa ne kaha ki bhindi zaroor laana, kyunki shaam ko mehmaan aane wala hai aur unhein bhindi ki sabzi bahut pasand hai. Lekin bhindi wali aunty aaj nahi aayi, toh Ramesh ne socha ki bhindi le leta hoon,", true],
  [["para-hi-04"], "bharta bhi toh sabko achha lagta hai. Wapas aate waqt baarish shuru ho gayi aur usne dukaan ke"],
  [["para-hi-05", "para-hi-06"], "chhajje ke neeche khade ho kar das minute intezaar kiya. Wahan ek budhe chacha mile jo pichhle chaalis saal se usi dukaan par baith kar akhbaar padhta hai aur har kisi ko salah deta hai."],
  [["para-hi-07"], "Unhone kaha, bete, zindagi mein jaldi mat karo, baarish ruk jaayegi, sabzi kahin bhaag nahi rahi."],
  [["para-hi-08", "para-hi-09"], "Ramesh muskuraya, chai pi, aur jab baadal chhate tab dheere dheere ghar ki taraf chal diya. Ghar pahunch kar pata chala ki mehmaan pehle hi aa chuke the aur maa ne jaldi jaldi daal chawal bana diye the. Sabne milkar khaaya, purani baatein yaad ki, aur der raat tak hanste rahe,"],
  [["para-hi-10", "para-hi-11"], "baingan ka bharta kal ke liye bach gaya."],
  [["para-gu-00"], "Roj savaare saat vaage Kavita ben potaana ghare, potaana ghar ni baari kholi ne aangna ma tulsi ne paani aape chhe. Pachhi te rasoda ma jaay chhe ane"],
  [["para-gu-01"], "aakhaa parivaar maate garam garam chaa ane thepla banaave chhe. Temno dikro Jay haji pan oonghto hoy chhe, ane tene uthaadva maate"],
  [["para-gu-02"], "traN vaar bum paadi ne. Aaje Jay ni school ma pariksha chhe, etle Kavita ben e raat na j teni chopdi ane pen thela ma muki deta hata.", true],
  [["para-gu-03"], "Bus stand ghare thi lagbhag paanch minute door chhe, pan Jay hammesha chhelli ghadiye doDto doDto pahonche chhe."],
  [["para-gu-04"], "Bapore Kavita ben bajaar jaay chhe, jyaan shaakbhaaji vaalo kaka temne joine kahe chhe, aavo ben,"],
  [["para-gu-05", "para-gu-06"], "aaje bhinda taaja chhe. Te be kilo bataka, ek kilo tameta, ane thoDi kothmir le chhe, ane hammesha ni jem bhaav ma thoDi rakjhak kare chhe. Ghare paachha aavi ne te"],
  [["para-gu-07"], "paDosan sathe otla par besi ne vaato kare chhe, ke kon dikro Amerika gayo ane kone tyaan lagan chhe."],
  [["para-gu-08"], "Saanje Jay khushkhush thai ne aave chhe ane kahe chhe ke pariksha saari gai,"],
  [["para-gu-09"], "ganit na badha sawaal aavDi gaya. Raat na jamvaa ma khichdi, kadhi, ane bhakhri bane chhe, ane Jay na pappa office thi"],
  [["para-gu-10"], "moDa aave toh pan sau saathe j jame chhe. Jamya pachhi sau TV saame besi ne cricket match", true],
  [["para-gu-11", "para-gu-12"], "jue chhe, ane Jay dar chhagga par uchhaLi ne taaLi paaDe chhe. Chhelle Kavita ben badha divaa, badha divaa bandh kare chhe, darvaajo tapaase chhe, ane vichaare chhe ke kaale bapore shu banaavvu.", true],
  [["twister-01-en-00"], "She sells seashells by the seashore, and the shells she sells are surely seashells.", true],
  [["twister-02-en-00"], "Peter Piper picked a peck of pickled peppers; where's the peck of pickled peppers Peter Piper picked?"],
  [["twister-03-en-00"], "How much wood would a woodchuck chuck if a woodchuck could chuck wood?", true],
  [["twister-04-en-00"], "Red lorry, yellow lorry, red lorry, yellow lorry, red lorry, yellow lorry."],
  [["twister-05-en-00"], "Unique New York, unique New York, you know you need unique New York."],
  [["twister-06-en-00"], "The sixth sick sheikh's sixth sheep's sick.", true],
  [["twister-07-en-00"], "Irish wristwatch, Swiss wristwatch, Irish wristwatch, Swiss wristwatch."],
  [["twister-08-hi-00"], "Kachcha papad, pakka papad, kachcha papad, pakka papad, pakka papad, kachcha papad, pakka papad."],
  [["twister-09-hi-00"], "Chandu ke chacha ne Chandu ki chachi ko chaandni raat mein chaandi ke chammach se chatni chatayi.", true],
];

for (const rate of [16000, 48000]) mkdirSync(`${DIR}/final/${rate / 1000}k`, { recursive: true });
const rows = final.map(([parts, text, unsure], i) => {
  const first = segs[parts[0]!], last = segs[parts.at(-1)!];
  const id = `${first.source}-${String(i).padStart(2, "0")}`;
  for (const rate of [16000, 48000])
    Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-i", `${DIR}/${manifest[first.source].file}`, "-ss", String(first.start), "-to", String(last.end), "-ac", "1", "-ar", String(rate), `${DIR}/final/${rate / 1000}k/${id}.wav`]);
  return { id, lang: first.lang, kind: first.kind, seconds: +(last.end - first.start).toFixed(2), text, unsure: !!unsure };
});
writeFileSync(`${DIR}/final/transcripts.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const sum = (f: (r: any) => boolean) => rows.filter(f).reduce((s, r) => s + r.seconds, 0).toFixed(0);
console.log(`${rows.length} clips, ${sum(() => true)} s total: en ${sum((r) => r.lang === "en")} s, hi ${sum((r) => r.lang === "hi")} s, gu ${sum((r) => r.lang === "gu")} s; unsure ${rows.filter((r) => r.unsure).length}; longest ${Math.max(...rows.map((r) => r.seconds))} s`);
