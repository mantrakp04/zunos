// Writing systems, for the "Read in" choice and for setting reading text in the right font and direction.

import { ENDONYMS } from "./screens/onboarding/endonyms";

/** Each language's own script by its own name; languages not listed fall back to their endonym. */
const SCRIPT_NAMES: Record<string, string> = {
  hi: "देवनागरी", mr: "देवनागरी", ne: "देवनागरी", sa: "देवनागरी",
  gu: "ગુજરાતી", bn: "বাংলা", as: "অসমীয়া", pa: "ਗੁਰਮੁਖੀ", ta: "தமிழ்", te: "తెలుగు", kn: "ಕನ್ನಡ",
  ml: "മലയാളം", si: "සිංහල", or: "ଓଡ଼ିଆ", ur: "اردو", sd: "سنڌي", ar: "العربية", fa: "فارسی", ps: "پښتو",
};

/** The name of a language's own script, written in it: "देवनागरी", "ગુજરાતી". */
export const scriptName = (lang: string) => SCRIPT_NAMES[lang] ?? ENDONYMS[lang] ?? lang;

const RTL = new Set(["ar", "fa", "ur", "ps", "sd", "he", "yi", "ug", "dv"]);

/** Text direction for reading text in this language and script. */
export const dirOf = (lang: string, script: "native" | "roman"): "rtl" | "ltr" | "auto" =>
  script === "roman" ? "ltr" : RTL.has(lang) ? "rtl" : "auto";

/** Any character outside Latin, Greek and Cyrillic: the text wants a native-script font stack. */
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u;
export const needsNativeFont = (text: string) => NON_LATIN.test(text);
