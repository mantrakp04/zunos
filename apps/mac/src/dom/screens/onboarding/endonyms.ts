// Each Whisper language (packages/db/src/languages.ts) in its own name and script.
export const ENDONYMS: Record<string, string> = {
  en: "English", zh: "中文", de: "Deutsch", es: "Español", ru: "Русский", ko: "한국어",
  fr: "Français", ja: "日本語", pt: "Português", tr: "Türkçe", pl: "Polski", ca: "Català",
  nl: "Nederlands", ar: "العربية", sv: "Svenska", it: "Italiano", id: "Bahasa Indonesia", hi: "हिन्दी",
  fi: "Suomi", vi: "Tiếng Việt", he: "עברית", uk: "Українська", el: "Ελληνικά", ms: "Bahasa Melayu",
  cs: "Čeština", ro: "Română", da: "Dansk", hu: "Magyar", ta: "தமிழ்", no: "Norsk",
  th: "ไทย", ur: "اردو", hr: "Hrvatski", bg: "Български", lt: "Lietuvių", la: "Latina",
  mi: "Māori", ml: "മലയാളം", cy: "Cymraeg", sk: "Slovenčina", te: "తెలుగు", fa: "فارسی",
  lv: "Latviešu", bn: "বাংলা", sr: "Српски", az: "Azərbaycanca", sl: "Slovenščina", kn: "ಕನ್ನಡ",
  et: "Eesti", mk: "Македонски", br: "Brezhoneg", eu: "Euskara", is: "Íslenska", hy: "Հայերեն",
  ne: "नेपाली", mn: "Монгол", bs: "Bosanski", kk: "Қазақша", sq: "Shqip", sw: "Kiswahili",
  gl: "Galego", mr: "मराठी", pa: "ਪੰਜਾਬੀ", si: "සිංහල", km: "ខ្មែរ", sn: "chiShona",
  yo: "Yorùbá", so: "Soomaali", af: "Afrikaans", oc: "Occitan", ka: "ქართული", be: "Беларуская",
  tg: "Тоҷикӣ", sd: "سنڌي", gu: "ગુજરાતી", am: "አማርኛ", yi: "ייִדיש", lo: "ລາວ",
  uz: "Oʻzbekcha", fo: "Føroyskt", ht: "Kreyòl ayisyen", ps: "پښتو", tk: "Türkmençe", nn: "Nynorsk",
  mt: "Malti", sa: "संस्कृतम्", lb: "Lëtzebuergesch", my: "မြန်မာ", bo: "བོད་སྐད་", tl: "Tagalog",
  mg: "Malagasy", as: "অসমীয়া", tt: "Татарча", haw: "ʻŌlelo Hawaiʻi", ln: "Lingála", ha: "Hausa",
  ba: "Башҡортса", jw: "Basa Jawa", su: "Basa Sunda", yue: "粵語",
};

/** How each romanized language looks typed in English letters, as in a chat. */
export const ROMANIZED_SAMPLE: Record<string, string> = {
  hi: "kal milte hain",
  gu: "kem cho, majama?",
  ta: "eppadi irukeenga?",
  ur: "aap kaise hain?",
  ml: "sukhamano?",
  te: "ela unnaru?",
  bn: "kemon acho?",
  kn: "hegiddira?",
  ne: "tapai lai kasto cha?",
  mr: "kasa aahes?",
  pa: "ki haal aa?",
};

/** "Hello" in a few of them, for the greeting that cycles above the title. */
export const GREETINGS: { text: string; lang: string }[] = [
  { text: "Hello", lang: "en" },
  { text: "नमस्ते", lang: "hi" },
  { text: "કેમ છો", lang: "gu" },
  { text: "Hola", lang: "es" },
  { text: "こんにちは", lang: "ja" },
  { text: "வணக்கம்", lang: "ta" },
  { text: "Bonjour", lang: "fr" },
  { text: "مرحبا", lang: "ar" },
  { text: "你好", lang: "zh" },
  { text: "Olá", lang: "pt" },
  { text: "안녕하세요", lang: "ko" },
  { text: "Hallo", lang: "de" },
];

export const endonym = (code: string, fallback: string) => ENDONYMS[code] ?? fallback;
