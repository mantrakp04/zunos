// Target languages for the reading corpus: Whisper's languages (src/languages.ts) that the reference
// recognizer also transcribes. Each profile says which script the text is written in, which variety and
// locale to write for, and, for languages not written in Latin script, how natives casually type it in
// English letters.
import { LANGUAGES } from "../../src/languages";

export type Script =
  | "Latin" | "Cyrillic" | "Greek" | "Armenian" | "Georgian" | "Hebrew" | "Arabic" | "Devanagari" | "Bengali"
  | "Gurmukhi" | "Gujarati" | "Tamil" | "Telugu" | "Kannada" | "Malayalam" | "Sinhala" | "Thai" | "Lao" | "Khmer"
  | "Myanmar" | "Ethiopic" | "Han" | "Japanese" | "Hangul";

export type Profile = {
  code: string;
  name: string;
  script: Script;
  /** Which variety, locale and register to write. */
  variety: string;
  /** How natives type this language in English letters; null for Latin-script languages. */
  roman: string | null;
  /** Reading speed in characters per second (spaces included), measured on `rateOn`. */
  rate: number;
  rateOn: "native" | "roman";
  /** Share of letters in native lines that may be Latin (brand names, acronyms, code-mixed words). */
  latinInNative: number;
  /** Extra punctuation allowed in this language besides . , ? ! : ' - */
  punct?: string;
  /** Roman lines may use non-ASCII Latin letters (only where that is how people actually type). */
  romanDiacritics?: boolean;
  /** Scales word-count targets: below 1 for languages with long (agglutinative or clitic-heavy) words. */
  wordScale: number;
};

// Languages whose words are long, so the same reading time holds fewer of them.
const WORD_SCALE: Record<string, number> = {
  ta: 0.65, te: 0.7, kn: 0.7, ml: 0.6, fi: 0.75, hu: 0.75, et: 0.8, tr: 0.75, az: 0.75, uz: 0.75, kk: 0.75,
  mn: 0.75, ka: 0.75, hy: 0.85, ko: 0.7, am: 0.75, si: 0.8, ar: 0.8, he: 0.85, fa: 0.9, ps: 0.9, sd: 0.9,
  ur: 0.95, mr: 0.85, bn: 0.9, as: 0.9, ne: 0.9, sw: 0.85, sn: 0.75, so: 0.85, ha: 0.95, lv: 0.85, lt: 0.85,
  ru: 0.85, uk: 0.85, be: 0.85, bg: 0.9, pl: 0.85, cs: 0.9, sk: 0.9, sl: 0.9, hr: 0.9, sr: 0.9, bs: 0.9, mk: 0.9,
  de: 0.9, nl: 0.95, is: 0.85, el: 0.9, mt: 0.9, tg: 0.85, ln: 0.9, jw: 0.9, tl: 0.9, id: 0.9, ms: 0.9,
};

const LATIN = 13; // chars/s for Latin-script reading aloud at a calm pace (the owner: English ~16 on clips)
const ROMAN = 12; // romanized text reads slower (the owner: Hindi 12.2, Gujarati 8.5, English 16.4 chars/s on clips)

type Row = [code: string, script: Script, variety: string, roman?: string, extra?: Partial<Profile>];

const ROWS: Row[] = [
  ["en", "Latin", "International English as a busy professional dictates it. US spelling. People, places and food from a mix of the US, UK, India, Canada, Australia, Ireland, Nigeria, South Africa and Singapore, so no one country dominates."],
  ["de", "Latin", "Standard German as spoken in Germany (occasionally Austria or Switzerland), everyday register, du in private messages and Sie in formal ones."],
  ["es", "Latin", "Contemporary Spanish, mostly as spoken in Mexico and the rest of Latin America, sometimes Spain; neutral vocabulary, ustedes rather than vosotros, no voseo.", undefined, { punct: "¿¡" }],
  ["fr", "Latin", "Contemporary French as spoken in France (occasionally Belgium, Switzerland or Quebec), tu with friends, vous in formal contexts."],
  ["pt", "Latin", "Brazilian Portuguese, everyday register (você, a gente), Brazilian spelling."],
  ["tr", "Latin", "Standard Turkish as spoken in Turkey (Istanbul, Ankara, Izmir and beyond)."],
  ["pl", "Latin", "Standard Polish as spoken in Poland."],
  ["ca", "Latin", "Standard Catalan as spoken in Catalonia, Valencia and the Balearic Islands, mostly Central Catalan."],
  ["nl", "Latin", "Standard Dutch as spoken in the Netherlands (occasionally Flanders)."],
  ["sv", "Latin", "Standard Swedish as spoken in Sweden."],
  ["it", "Latin", "Standard Italian as spoken in Italy."],
  ["id", "Latin", "Indonesian as people really speak and write messages (natural, not stiff textbook bahasa baku in casual lines; standard in formal lines), Jakarta and beyond."],
  ["fi", "Latin", "Finnish. Use standard written Finnish (kirjakieli) in formal lines and the light everyday forms Finns actually write in messages (mä, sä, ollaan) in casual lines."],
  ["vi", "Latin", "Vietnamese with full diacritics, everyday register, Hanoi and Ho Chi Minh City and beyond."],
  ["ms", "Latin", "Malaysian Malay (Bahasa Melayu) as spoken in Malaysia, natural everyday register."],
  ["cs", "Latin", "Standard Czech, everyday register (spisovná čeština with natural common forms in casual lines)."],
  ["ro", "Latin", "Standard Romanian with correct diacritics (ș and ț with comma below, ă, â, î)."],
  ["da", "Latin", "Standard Danish as spoken in Denmark."],
  ["hu", "Latin", "Standard Hungarian as spoken in Hungary."],
  ["no", "Latin", "Norwegian Bokmål as spoken in Norway."],
  ["hr", "Latin", "Standard Croatian as spoken in Croatia."],
  ["lt", "Latin", "Standard Lithuanian as spoken in Lithuania."],
  ["mi", "Latin", "Te reo Māori as spoken in Aotearoa New Zealand today, with macrons (ā ē ī ō ū); everyday contexts of modern Māori life."],
  ["cy", "Latin", "Modern Welsh as spoken in Wales, everyday register."],
  ["sk", "Latin", "Standard Slovak as spoken in Slovakia."],
  ["lv", "Latin", "Standard Latvian as spoken in Latvia."],
  ["az", "Latin", "Azerbaijani in the Latin alphabet as spoken in Azerbaijan (Baku and beyond)."],
  ["sl", "Latin", "Standard Slovenian as spoken in Slovenia."],
  ["et", "Latin", "Standard Estonian as spoken in Estonia."],
  ["is", "Latin", "Standard Icelandic as spoken in Iceland, with þ, ð, æ and accented vowels."],
  ["bs", "Latin", "Bosnian in the Latin alphabet as spoken in Bosnia and Herzegovina."],
  ["sw", "Latin", "Standard Swahili as spoken in Kenya and Tanzania, natural everyday register."],
  ["gl", "Latin", "Standard Galician as spoken in Galicia."],
  ["sn", "Latin", "Shona (chiShona) as spoken in Zimbabwe, standard orthography, natural everyday register."],
  ["yo", "Latin", "Yoruba as spoken in Nigeria. Write the under-dots (ẹ, ọ, ṣ) but no tone marks, the way Yoruba is usually typed on phones; use the same spelling for a word every time."],
  ["so", "Latin", "Somali in the official Latin orthography, as spoken in Somalia, Somaliland and the diaspora."],
  ["af", "Latin", "Afrikaans as spoken in South Africa and Namibia."],
  ["oc", "Latin", "Occitan in the standard Languedocien (lengadocian) form and classical orthography, everyday modern contexts in southern France."],
  ["uz", "Latin", "Uzbek in the official Latin alphabet (oʻ, gʻ with the ʻ letter, sh, ch, ng) as spoken in Uzbekistan."],
  ["mt", "Latin", "Maltese as spoken in Malta, with ċ, ġ, ħ, ż, għ, and the English words Maltese speakers naturally use."],
  ["lb", "Latin", "Luxembourgish as spoken in Luxembourg, current official spelling."],
  ["tl", "Latin", "Filipino (Tagalog) as spoken in Metro Manila and beyond, with natural Taglish where Filipinos really mix English."],
  ["ln", "Latin", "Lingala as spoken in Kinshasa and Brazzaville, natural everyday register with the French words speakers really use."],
  ["ha", "Latin", "Hausa in the standard Latin (boko) orthography with ɓ, ɗ, ƙ and ƴ, as spoken in Nigeria and Niger."],
  ["jw", "Latin", "Javanese in Latin script as spoken in Central and East Java: ngoko for casual lines, krama where politeness needs it."],
  ["zh", "Han", "Mandarin Chinese in Simplified characters as written in mainland China, everyday register, Chinese punctuation (，。？！：).",
    "Hanyu Pinyin without tone marks, words separated by spaces the way they are grouped in pinyin (ni hao, mingtian, women), proper nouns capitalized, ü written as v or u per common habit (use u except lv/nv).",
    { rate: 4, rateOn: "native", latinInNative: 0.25, punct: "，。？！：、" }],
  ["yue", "Han", "Written colloquial Cantonese (Hong Kong), Traditional characters, as Hongkongers type messages (係, 唔, 咗, 嘅, 啲), with the English words they naturally mix in.",
    "Jyutping letters without tone numbers, one syllable per space-separated word as in casual Hong Kong typing (nei hou, m goi, sik zo faan mei), English words kept in English.",
    { rate: 4.5, rateOn: "native", latinInNative: 0.25, punct: "，。？！：、" }],
  ["ja", "Japanese", "Natural contemporary Japanese, polite form (desu/masu) for work and strangers, plain form with friends and family, standard Japanese punctuation (、。？！).",
    "Hepburn-style romaji without macrons as people type it: long vowels in words as ou/uu/ei as typed on a keyboard (arigatou, benkyou, kuukou) but well-known place names in their usual English form (Tokyo, Osaka), particles as pronounced (wa, e, o), words separated by spaces.",
    { rate: 5.5, rateOn: "native", latinInNative: 0.2, punct: "、。？！：・" }],
  ["ko", "Hangul", "Standard Korean (Seoul), 존댓말 for work and strangers, 반말 with close friends, normal Korean spacing.",
    "Revised Romanization without diacritics, keeping Korean word spacing (annyeonghaseyo, gamsahamnida, naeil mannayo).",
    { rate: 5.5, rateOn: "native", latinInNative: 0.15 }],
  ["ru", "Cyrillic", "Standard Russian as spoken in Russia, everyday register, ты with friends and вы in formal contexts.",
    "Casual Latin transliteration as Russians type when they have no Cyrillic keyboard: zh, kh, ts, ch, sh, shch, y for й, ya, yu, yo, e for э, soft and hard signs dropped (privet, spasibo, zavtra, seychas, pozvoni mne)."],
  ["uk", "Cyrillic", "Standard Ukrainian as spoken in Ukraine.",
    "Casual Latin transliteration as Ukrainians type it: kh, zh, ts, ch, sh, shch, y for и, i for і, yi for ї, ye for є, ya, yu, soft sign dropped (pryvit, dyakuyu, zavtra)."],
  ["el", "Greek", "Standard Modern Greek as spoken in Greece and Cyprus, everyday register.",
    "Phonetic Greeklish as Greeks type in chats: i for η/ι/υ/ει/οι, o for ω, e for αι, th for θ, ch or h for χ, d for δ, ps, ks, mp/nt as written (kalimera, efharisto, ti kaneis, tha se do avrio). Choose one spelling per word and keep it.",
    { punct: ";·" }],
  ["he", "Hebrew", "Modern Israeli Hebrew without niqqud, everyday register.",
    "Casual Latin as Israelis type it: ch for ח and כ, tz for צ, sh for ש, apostrophes only where common (shalom, toda, ma nishma, nitraeh machar)."],
  ["ar", "Arabic", "Modern Standard Arabic as used in everyday writing across the Arab world: light, contemporary and plain, not classical; no tashkeel; names and places from across the Arab world.",
    "Arabizi as people type it in chats: 2 for ء, 3 for ع, 7 for ح, 5 for خ, gh for غ, sh for ش, th for ث, dh for ذ, q for ق, ou or u for long u, ee or i for long i, aa or a for long a; keep the same spelling for a word every time (marhaba, shukran, 7abibi, ma3 salama).",
    { punct: "،؟؛" }],
  ["ta", "Tamil", "Tamil as people in Tamil Nadu really write: natural spoken-style Tamil (pesum tamil) in messages, notes and voice notes; standard written Tamil only in formal lines like emails or announcements; English words where Tamils really use them.",
    "Tanglish as Tamils type in chats: zh for ழ, th for த, dh for soft த/ட in speech, ch or s as pronounced, double letters for long vowels only where common (vanakkam, enna panra, naalaikku paakalam, saapiteengala)."],
  ["th", "Thai", "Standard Thai (Bangkok), everyday register with natural polite particles (ครับ/ค่ะ) where Thais would use them; spaces only between phrases as in normal Thai writing.",
    "Casual 'karaoke' Thai as Thais type in English letters, no tone marks, words separated by spaces (sawasdee krub, khob khun ka, pai nai, prung nee)."],
  ["ur", "Arabic", "Urdu as written in Pakistan (Nastaliq-style Urdu script in Unicode), natural everyday register with the English words Pakistanis really use.",
    "Roman Urdu as Pakistanis type it in WhatsApp: kya, hai, nahi, mein, kr/kar (pick kar), acha, theek, kal, bhai; kh for خ, gh for غ, sh for ش; no diacritics.",
    { punct: "،؟۔" }],
  ["bg", "Cyrillic", "Standard Bulgarian as spoken in Bulgaria.",
    "Casual Latin (shlyokavitsa) as Bulgarians type: sh, ch, zh, sht for щ, a for ъ, ya, yu, ts (zdravey, blagodarya, utre, shte se vidim)."],
  ["ml", "Malayalam", "Malayalam as Malayalis really write: natural spoken-style Malayalam in messages and notes, standard written style in formal lines, English words where Malayalis really use them.",
    "Manglish as Malayalis type in chats: zh for ഴ, th, dh, ch, sh as pronounced, double vowels for long sounds where common (enthu parayunnu, njan varam, nale kaanam, sheri)."],
  ["te", "Telugu", "Telugu as people in Andhra Pradesh and Telangana really speak and write messages (natural spoken style, standard style in formal lines), with the English words Telugu speakers really use.",
    "Telugu typed in English letters as in chats (ela unnav, emi chestunnav, repu kaluddam, sare)."],
  ["fa", "Arabic", "Standard Persian as written in Iran, with the light colloquial forms Iranians use in personal messages; zero-width non-joiner where standard (می‌خواهم).",
    "Finglish as Iranians type in chats: kh for خ, gh for غ and ق, sh, ch, zh, a/aa as pronounced, e for kasra, o for zamma (salam, merci, khoobi, farda mibinamet).",
    { punct: "،؟؛" }],
  ["bn", "Bengali", "Standard colloquial Bengali (cholito bhasha) as spoken in Kolkata and Dhaka, with the English words Bengalis really use. End statements with the danda (।) in the native line, as is standard; the roman line uses a period.",
    "Banglish as Bengalis type in chats (kemon acho, ami ashchi, kal dekha hobe, thik ache), consistent spellings."],
  ["sr", "Cyrillic", "Standard Serbian (ekavian) as spoken in Serbia, written in Cyrillic.",
    "Serbian Latin alphabet (latinica) exactly as Serbs write it: č, ć, š, ž, đ, dž, lj, nj.",
    { romanDiacritics: true }],
  ["kn", "Kannada", "Kannada as people in Karnataka (Bengaluru, Mysuru, Hubballi) really speak and write messages, with the English words Kannadigas really use.",
    "Kannada typed in English letters as in chats (hegiddiya, oota aytha, naale sigona, sari)."],
  ["mk", "Cyrillic", "Standard Macedonian as spoken in North Macedonia.",
    "Casual Latin as Macedonians type: sh, ch, zh, kj for ќ, gj for ѓ, dz for ѕ, dj for џ, lj, nj (zdravo, blagodaram, utre ke se vidime)."],
  ["hy", "Armenian", "Standard Eastern Armenian as spoken in Armenia, everyday register.",
    "Casual Latin as Armenians type: sh, ch, zh, gh, kh, ts, dz, u for ու, e for է and ե (barev, inch ka, shnorhakalutyun, vaghy khosenq).",
    { punct: "՞՛՜։" }],
  ["hi", "Devanagari", "Hindi as people in North India (Delhi, Lucknow, Jaipur, Mumbai, Patna, Indore) really speak and write messages: natural everyday Hindi with the English words urban Indians really use (meeting, office, charger, deadline), not shuddh or bookish Hindi. End statements with the danda (।) in the native line, as is standard; the roman line uses a period.",
    "Hinglish as Indians type in WhatsApp: hai, nahi, kya, kar, raha, mein, bhi, toh, kal, achha, theek, haan; aa/ee/oo only where commonly typed (aaj, kaam, theek, pooch); no diacritics; English words spelled in English (kal meeting hai, main 5 baje aaunga)."],
  ["ne", "Devanagari", "Nepali as spoken in Kathmandu and across Nepal, natural everyday register with the English words Nepalis really use. End statements with the danda (।) in the native line, as is standard; the roman line uses a period.",
    "Romanized Nepali as Nepalis type in chats (k cha, sanchai, bholi bhetaula, khana khayau)."],
  ["mn", "Cyrillic", "Mongolian in Cyrillic as spoken in Mongolia (Ulaanbaatar and beyond).",
    "Casual Latin as Mongolians type: u for ү and у, o for ө and о, kh or h for х (pick kh), ts, ch, sh, j for ж, ii for ий/ы (sain baina uu, bayarlalaa, margaash uulzii)."],
  ["kk", "Cyrillic", "Kazakh in Cyrillic as spoken in Kazakhstan, with the Russian words Kazakhs naturally use.",
    "Casual Latin as Kazakhs type: a for ә, o for ө, u for ұ and ү, i for і and ы, g for ғ, q for қ, ng for ң, sh, zh, ch (salem, rakhmet, erteng koriskenshe)."],
  ["mr", "Devanagari", "Marathi as spoken in Maharashtra (Pune, Mumbai, Nagpur), natural everyday register with the English words Marathi speakers really use.",
    "Marathi typed in English letters as in chats (kay karto, mi yeto, udya bhetu, chalel)."],
  ["pa", "Gurmukhi", "Punjabi in Gurmukhi as spoken in Indian Punjab, natural everyday register with the English words Punjabis really use. End statements with the danda (।) in the native line, as is standard; the roman line uses a period.",
    "Punjabi typed in English letters as in chats (ki haal aa, main aunda haan, kal milde haan, theek aa)."],
  ["si", "Sinhala", "Sinhala as Sri Lankans really write messages: natural spoken-style Sinhala in casual lines, standard written style in formal lines, with the English words Sri Lankans really use.",
    "Singlish as Sri Lankans type in chats (kohomada, mama enawa, heta hambemu, hari)."],
  ["km", "Khmer", "Standard Khmer as spoken in Cambodia (Phnom Penh), everyday register.",
    "Casual Khmer in English letters as Cambodians type in chats (sour sdey, arkun, nh tov na, chhnganh), consistent spellings.",
    { punct: "។៕" }],
  ["ka", "Georgian", "Standard Georgian as spoken in Georgia (Tbilisi, Kutaisi, Batumi), everyday register.",
    "Casual Latin as Georgians type in chats: sh, ch, kh, gh, ts, dz, zh, j, no capitals inside words (gamarjoba, madloba, rogor khar, khval shevkhvdet)."],
  ["be", "Cyrillic", "Standard Belarusian (tarashkevica is not used; use the official narkamauka spelling).",
    "Casual Latin transliteration as Belarusians type without Cyrillic: zh, kh, ts, ch, sh, u for ў, ya, yu, ye, soft sign dropped (pryvitannie, dziakuj, zautra)."],
  ["tg", "Cyrillic", "Tajik in Cyrillic as spoken in Tajikistan (Dushanbe and beyond), with the Russian words Tajiks naturally use.",
    "Casual Latin as Tajiks type: i for ӣ, u for ӯ, h for ҳ, q for қ, gh for ғ, j for ҷ, sh, ch, zh, ya, yu (salom, rahmat, pagoh vokhurem)."],
  ["sd", "Arabic", "Sindhi in the Perso-Arabic Sindhi alphabet as written in Sindh, Pakistan, natural everyday register.",
    "Sindhi typed in English letters as in chats (kehro haal aa, maan achan tho, subhane milandasin), consistent spellings.",
    { punct: "،؟۔" }],
  ["gu", "Gujarati", "Gujarati as spoken in Gujarat (Ahmedabad, Surat, Vadodara, Rajkot) and by Gujaratis everywhere, natural everyday register with the English words Gujaratis really use; plain spoken Gujarati, never formal or Sanskritized words where people say a simpler or English one.",
    "Gujlish as Gujaratis type in chats (kem cho, hu aavu chhu, kale maliye, saru), English words spelled in English."],
  ["am", "Ethiopic", "Amharic as spoken in Ethiopia (Addis Ababa and beyond), everyday register.",
    "Amharic in English letters as Ethiopians type in chats (selam, endet neh, ameseginalehu, nege enegenagn), consistent spellings.",
    { punct: "።፣፤፡፥፦" }],
  ["lo", "Lao", "Standard Lao as spoken in Laos (Vientiane), everyday register.",
    "Casual Lao in English letters as Lao people type (sabaidee, khop jai, pai sai, meu ken), consistent spellings."],
  ["ps", "Arabic", "Pashto as spoken in Afghanistan and Khyber Pakhtunkhwa, standard Pashto spelling, everyday register.",
    "Pashto typed in English letters as in chats (sanga ye, manana, saba ba sara wogoro), consistent spellings.",
    { punct: "،؟۔" }],
  ["my", "Myanmar", "Standard Burmese in Unicode (never Zawgyi) as spoken in Myanmar (Yangon, Mandalay), everyday register.",
    "Casual Burmese in English letters as people in Myanmar type in chats (mingalarbar, kyay zu tin bar tal, ma nat phyan twae mal), consistent spellings.",
    { punct: "။၊" }],
  ["as", "Bengali", "Assamese in the Assamese script (with ৰ and ৱ) as spoken in Assam, natural everyday register. End statements with the danda (।) in the native line, as is standard; the roman line uses a period.",
    "Assamese typed in English letters as in chats (kene asa, moi ahi asu, kaali log pam), consistent spellings."],
];

export const PROFILES: Profile[] = ROWS.map(([code, script, variety, roman, extra]) => {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) throw new Error(`unknown language ${code}`);
  const isLatin = script === "Latin";
  return {
    code,
    name: code === "tl" ? "Filipino (Tagalog)" : code === "jw" ? "Javanese" : lang.name === "Myanmar" ? "Burmese" : lang.name,
    script,
    variety,
    roman: isLatin ? null : roman ?? null,
    rate: isLatin ? LATIN : ROMAN,
    rateOn: isLatin ? "native" : "roman",
    latinInNative: isLatin ? 1 : 0.12,
    wordScale: WORD_SCALE[code] ?? 1,
    // The danda ends sentences in Hindi, Nepali, Bengali, Assamese and Punjabi (Marathi mostly uses a full stop).
    punct: ["Devanagari", "Bengali", "Gurmukhi"].includes(script) ? "।" : undefined,
    ...extra,
  };
});

export const profile = (code: string) => {
  const p = PROFILES.find((x) => x.code === code);
  if (!p) throw new Error(`no corpus profile for ${code}`);
  return p;
};
