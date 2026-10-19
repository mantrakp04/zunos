// Prompts for the corpus generator: a per-language style guide (brief), passages, dictation sentences,
// a native-editor review, repairs, a diversity review and a spelling-consistency pass.
import type { Item } from "./checks";
import { BOUNDS } from "./checks";
import type { Profile } from "./langs";
import type { Msg } from "./llm";

export type Brief = {
  variety: string;
  orthography: string;
  numbers: string;
  codeMixing: string;
  romanization: string | null;
  spellings: { native: string; roman: string }[];
  givenNames: string[];
  familyNames: string[];
  places: string[];
  food: string[];
  everyday: string[];
  avoid: string[];
};

/** Passage slots: one register each, with topics the writer localizes. */
export const PASSAGE_SLOTS: { register: string; topics: string[] }[] = [
  { register: "a voice note or long chat message to a friend or family member (casual, spoken)",
    topics: ["weekend plans that keep changing", "news about a new job", "a family wedding or function coming up", "moving to a new flat",
      "a surprise birthday plan", "a trip back to the home town", "a match everyone watched last night", "a new pet at home"] },
  { register: "a work email or team update dictated to a colleague or team (polite, clear, concrete)",
    topics: ["a project running late and the new plan", "summary and next steps after a client meeting", "welcoming a new teammate",
      "handing over work before going on leave", "the office moving floors", "feedback from users on a new feature", "a vendor quote comparison"] },
  { register: "a short personal story told aloud (past tense, vivid concrete details)",
    topics: ["missing the last train or bus", "cooking for guests when things went wrong", "a power cut on a busy evening", "getting lost in a new city",
      "learning to drive or ride", "a kind stranger or neighbor who helped", "a market day that turned into rain", "the first day at a new school or job"] },
  { register: "explaining how to do something, step by step (instructions)",
    topics: ["a well-loved local dish", "setting up a new phone for a parent", "paying a utility bill online", "making tea or coffee the local way",
      "packing for a long journey", "the rules of a local card or board game", "looking after a balcony garden"] },
  { register: "an opinion or review (casual but thoughtful)",
    topics: ["a restaurant or street food stall", "a new phone or laptop", "a film or series everyone is talking about", "a weekend getaway",
      "a food delivery or ride app", "a book read on holiday", "a gym or fitness class"] },
  { register: "planning out loud with lots of numbers: dates, times, prices, distances, counts",
    topics: ["a three-day trip with a budget", "organizing a family dinner for many guests", "a monthly household budget", "a school or college admission timeline",
      "a team offsite", "renovating a kitchen", "a wedding shopping list"] },
  { register: "a polite phone call or message to a service (bank, clinic appointment, landlord, delivery, school, repair technician)",
    topics: ["rescheduling a doctor's appointment", "a parcel delivered to the wrong address", "a broken washing machine under warranty", "a wrong charge on a card",
      "asking the landlord about a leaking tap", "a child's school fee receipt", "an internet connection that keeps dropping"] },
  { register: "an informative description in a slightly more formal register, like a short local radio or blog piece",
    topics: ["a famous local market", "a festival and how it is celebrated", "a neighborhood and how it has changed", "a traditional craft or local industry",
      "a nature spot near a big city", "a local sport and its fans", "public transport in a big city"] },
];

/** Dictation sentence categories, with weights that set their share of the sentences. */
export const CATEGORIES: { key: string; weight: number; what: string }[] = [
  { key: "chat", weight: 14, what: "Messages to friends and family: plans, check-ins, requests, quick replies, jokes, updates (reached home, call me when you are free, keep some food for me)." },
  { key: "work", weight: 13, what: "Work chat and email lines: updates, requests, scheduling, follow-ups, approvals, polite openings and sign-offs." },
  { key: "numbers", weight: 14, what: "Lines dense with numbers as people really dictate them: times, dates and days, prices and amounts of money, phone numbers, quantities, distances, percentages, addresses, flight, train, seat or room numbers, scores, ages. Mix several kinds; use realistic local formats and values." },
  { key: "notes", weight: 11, what: "Notes to self, reminders, to-do items, calendar entries and shopping lists, said as full sentences (remind me to..., add ... to the list, note that...)." },
  { key: "assistant", weight: 11, what: "Things people say to their phone or computer: search queries, questions, and voice commands (set a timer, navigate to..., call..., what is the weather...), phrased the way people actually talk to a device." },
  { key: "tech", weight: 11, what: "Tech and work talk: apps, devices, files, internet, accounts, software, meetings, bugs and fixes, with exactly the English terms speakers of this language really use." },
  { key: "people", weight: 10, what: "Lines with people's names and places: meeting someone somewhere, directions, travel and commuting, neighborhoods, landmarks, shops and local businesses, relatives and colleagues by name." },
  { key: "daily", weight: 10, what: "Everyday life: food and cooking, shopping and bargaining, home and repairs, weather, appointments, school and kids, errands, festivals and family occasions." },
  { key: "spoken", weight: 10, what: "Dictation as it really comes out: self-corrections (no wait, make that Thursday; sorry, I meant the blue one), items listed aloud (get milk, eggs and two loaves of bread), quick questions, and sentences that change direction halfway, all written out exactly as said." },
  { key: "feelings", weight: 6, what: "Opinions, feelings and reactions: apologies, thanks, compliments, mild complaints, encouragement, and some longer reflective sentences." },
];

const romanRules = (p: Profile) =>
  p.romanDiacritics
    ? `the Latin alphabet exactly as ${p.name} speakers write it (with its diacritics). ${p.roman}`
    : `the way ${p.name} speakers casually type in chats and WhatsApp. It is NOT a scholarly transliteration: no diacritics, no capital letters inside words to mark sounds, no special symbols. ${p.roman}`;

function ruleBlock(p: Profile) {
  const punct = p.punct ? ` and ${[...p.punct].join(" ")}` : "";
  return `WHAT THIS TEXT IS FOR
A person who speaks ${p.name} reads these lines aloud, one line at a time, to teach a speech recognizer their voice. The exact text of each line becomes the transcript the recognizer learns to write, and later they use it to dictate messages, notes, emails and searches. So every line must be:
- something a ${p.name} speaker would really say out loud AND write exactly this way;
- natural, idiomatic, contemporary ${p.name}: think in ${p.name}, never translate from English; no textbook stiffness, no literary or archaic words, no stock machine-written phrasing;
- a complete sentence (or two short ones) that stands on its own as a recording, with one obvious way to read it aloud;
- correct: standard spelling, grammar and diacritics for the variety, normal sentence punctuation.

VARIETY
${p.variety}

CONTENT RULES
- Culturally local: local given and family names (mixed genders, ages, regions and communities), real cities, neighborhoods, streets, landmarks, local dishes, shops, transport, festivals, institutions, apps and everyday situations. No stereotypes.
- Everyday spoken vocabulary: prefer the word people actually say over formal, Sanskritized, literary, bureaucratic or textbook words, and use the English word wherever natives really say the English word (list, client, main page, update). English words only where ${p.name} speakers really use them in speech (tech, office, apps, brands), written the way they write them.
- Wide vocabulary: every line should bring its own nouns, verbs and details; avoid reusing the same words, names and situations across lines.
- Easy to read at a calm pace: no tongue twisters, no long chains of clauses, no deliberately hard or rare words.
- Numbers: digits 0-9 (never native-script digits) for times, dates, prices, phone numbers, quantities, measurements, percentages, addresses, flight, train, seat and room numbers, in the local format and local currency. Small counts inside running text may be words where that is how natives write them. Every number must have one obvious spoken reading.
- Punctuation: only . , ? ! : ' -${punct}. Never quotation marks, brackets, slashes, semicolons, ellipses, emojis, hashtags, @handles, URLs, email addresses, bullet points, or symbols other than % and currency signs. Avoid abbreviations unless people say them letter by letter or exactly as written.
- Nothing sensitive or offensive: no politics, religious debate, sexual content, violence, crime, drugs, alcohol-centered scenes, slurs, health scares, medical or legal advice, and no real private persons. Everyday life, work, family, friends, food, travel, study, hobbies, tech and errands.
- No stage directions, speaker labels or line numbers inside the text.`;
}

function romanBlock(p: Profile) {
  if (!p.roman) return "";
  return `

TWO VERSIONS OF EVERY LINE
${p.name} is not written in Latin script, so every line comes twice:
- "native": the line in ${p.script === "Japanese" ? "Japanese" : p.script} script, as a careful native writes it.
- "roman": the very same line in English letters, ${romanRules(p)}
The roman line must contain exactly the same words as the native line in the same order (reading either aloud gives the same speech), the same numbers as the same digits, the same punctuation written with ASCII marks (native marks such as । ، ؟ 。 、 become . , ?), and capitals only where English would use them (sentence start, names). English words and brand names keep their normal English spelling. Spell each word the same way every time, following the spelling guide.`;
}

function briefBlock(p: Profile, b: Brief, pick?: { names: string[]; places: string[]; food: string[]; everyday: string[] }) {
  const spell = p.roman && b.spellings.length
    ? `\nSpelling guide (native = roman): ${b.spellings.map((s) => `${s.native} = ${s.roman}`).join("; ")}`
    : "";
  const ideas = pick
    ? `\nIdeas you may draw on (do not force them in; vary freely beyond them):\n- names: ${pick.names.join(", ")}\n- places: ${pick.places.join(", ")}\n- food: ${pick.food.join(", ")}\n- everyday life: ${pick.everyday.join(", ")}`
    : "";
  return `

STYLE GUIDE FOR ${p.name.toUpperCase()}
- Variety: ${b.variety}
- Orthography: ${b.orthography}
- Numbers: ${b.numbers}
- English mixing: ${b.codeMixing}${b.romanization ? `\n- Romanization: ${b.romanization}` : ""}
- Avoid: ${b.avoid.join(" | ")}${spell}${ideas}`;
}

export function writerSystem(p: Profile) {
  return `You are a native ${p.name} speaker and an experienced ${p.name} writer. You write reading material for speech-recognition training that sounds exactly like real people talking.

${ruleBlock(p)}${romanBlock(p)}`;
}

const UNSPACED = ["Han", "Japanese", "Thai", "Lao", "Khmer", "Myanmar"];
/** A length range in words, or in characters for scripts written without spaces. */
function size(p: Profile, w1: number, w2: number) {
  if (!UNSPACED.includes(p.script)) return `${Math.max(2, Math.round(w1 * p.wordScale))}-${Math.round(w2 * p.wordScale)} words`;
  const perWord = p.script === "Han" ? 1.7 : p.script === "Japanese" ? 2.6 : 4; // characters per English-word-equivalent
  return `${Math.round(w1 * perWord)}-${Math.round(w2 * perWord)} characters`;
}

const itemShape = (p: Profile, extra = "") =>
  p.roman ? `{${extra}"native": [...lines], "roman": [...same lines in English letters]}` : `{${extra}"native": [...lines]}`;

export function briefPrompt(p: Profile): Msg[] {
  const romanFields = p.roman
    ? `"romanization": "the rules for the casual roman version: which letters for which sounds, long vowels, doubled consonants, English words, names; with examples",
  "spellings": [{"native": "...", "roman": "..."}],  // 100-150 entries: the most frequent words (pronouns, verbs and auxiliaries, postpositions or particles, question words, numbers words, greetings) plus common English loanwords as written in ${p.script} script, each with the ONE casual spelling to use`
    : `"romanization": null,
  "spellings": [],`;
  return [
    { role: "system", content: writerSystem(p) },
    { role: "user", content: `Before writing anything, prepare a style guide that keeps all the ${p.name} material consistent and authentic. Answer with this JSON object:
{
  "variety": "2-4 sentences: the variety and register(s) to use, how formal for messages versus emails versus announcements, and the pronoun or politeness choices",
  "orthography": "spelling and punctuation conventions for the text, and the common mistakes to avoid",
  "numbers": "how people write times, dates, days, prices with currency, phone numbers, percentages, ordinals and addresses in this variety, one example each",
  "codeMixing": "which English words speakers really use in everyday speech and work talk, how they write them, and what NOT to anglicize",
  ${romanFields}
  "givenNames": [40 given names, mixed genders, generations, regions and communities],
  "familyNames": [20 family names],
  "places": [40 real places: cities, towns, neighborhoods, streets, landmarks, markets, stations, malls, parks],
  "food": [30 local dishes, snacks, drinks and ingredients],
  "everyday": [30 local everyday things: shops, services, apps and websites people use, transport, festivals and occasions, institutions, school and office terms, household items],
  "avoid": [15 concrete patterns that make written ${p.name} sound translated or machine-written, each with the natural alternative]
}` },
  ];
}

export function passagesPrompt(p: Profile, b: Brief, slots: { register: string; topic: string }[], pick: Parameters<typeof briefBlock>[2], previous: Item[]): Msg[] {
  const prev = previous.length
    ? `\n\nPassages already written (choose different people, places and details):\n${previous.map((x) => `- ${x.title}: ${x.native[0]}`).join("\n")}`
    : "";
  return [
    { role: "system", content: writerSystem(p) + briefBlock(p, b, pick) },
    { role: "user", content: `Write ${slots.length} passages for ${p.name} speakers to read aloud, one per assignment:
${slots.map((s, i) => `${i + 1}. Register: ${s.register}. Topic: ${s.topic}, set somewhere local.`).join("\n")}

Each passage is read in one take and cut into clips at every line break, so:
- ${BOUNDS.para.lines[0] + 1}-${BOUNDS.para.lines[1] - 1} lines, 35-65 seconds aloud in total at a calm pace;
- every line is one complete, natural sentence of ${size(p, 6, 16)} (short to medium, 3-7 seconds aloud) that makes sense heard on its own; never break a sentence across lines, and split long thoughts into separate lines;
- vary sentence length and structure; keep the register of the assignment; use concrete local details (names, places, times, prices, food) where they fit;
- the passage flows as one piece that a real ${p.name} speaker could have said or written.
Give each passage a short English title (2-6 words) that says what it is.${prev}

Answer with JSON: {"passages": [${itemShape(p, '"title": "...", ')}]}` },
  ];
}

export function sentencesPrompt(p: Profile, b: Brief, cat: (typeof CATEGORIES)[number], n: number, pick: Parameters<typeof briefBlock>[2], existing: string[], guidance: string): Msg[] {
  const short = Math.round(n * 0.3), long = Math.round(n * 0.2), mid = n - short - long;
  const prev = existing.length
    ? `\n\nAlready in the corpus (do not repeat their ideas, wording, openings or names; vary further):\n${existing.map((s) => `- ${s}`).join("\n")}`
    : "";
  return [
    { role: "system", content: writerSystem(p) + briefBlock(p, b, pick) },
    { role: "user", content: `Write ${n} different sentences that ${p.name} speakers would really dictate to their phone or computer, or say in everyday life.
Category: ${cat.what}

Lengths: about ${short} short (${size(p, 4, 7)}), ${mid} medium (${size(p, 8, 13)}) and ${long} longer (${size(p, 14, 20)}). Each item is a single line.
Make every sentence distinct in situation, structure, opening word and vocabulary (new nouns, verbs, names, numbers and places in each); give them a real speaker's voice (natural fillers like okay or listen only where natives would say them). About a third of the sentences mention a local name, place, dish or price where a speaker naturally would; the rest need none. Never tack on a city or a name just for local color.${guidance ? `\n\nAlso: ${guidance}` : ""}${prev}

Answer with JSON: {"sentences": [${p.roman ? `{"native": "...", "roman": "..."}` : `{"native": "..."}`}]}` },
  ];
}

export function reviewSystem(p: Profile, b: Brief) {
  return `You are a meticulous native ${p.name} editor. You check reading material written for ${p.name} speakers: they read each line aloud to train a speech recognizer, and the exact text becomes the transcript a dictation model learns to write. You are strict: you only pass lines a native would find completely natural, correct and useful. Write your notes in English.

${ruleBlock(p)}${romanBlock(p)}${briefBlock(p, b)}`;
}

export function reviewPrompt(p: Profile, b: Brief, items: (Item & { note?: string })[]): Msg[] {
  const shown = items.map((x) => ({ id: x.id, kind: x.kind, ...(x.title ? { title: x.title } : {}), native: x.native, ...(x.roman ? { roman: x.roman } : {}), ...(x.note ? { category: x.note } : {}) }));
  return [
    { role: "system", content: reviewSystem(p, b) },
    { role: "user", content: `Review each item. Score 1-5 (5 = flawless, 4 = good enough to ship, 3 = noticeably off):
- natural: would a native really say AND write exactly this? Anything that smells translated, stiff, bookish, over-explained or machine-written scores 3 or less.
- correct: spelling, grammar, diacritics and punctuation of the native line${p.roman ? "" : " (the only line)"}; facts about real places must be plausible.
${p.roman ? `- roman: exactly the same words as the native line, casual chat spelling as specified, consistent with the spelling guide, same digits.\n` : ""}- fit: for a sentence, something a person really dictates, types or says to a device (message, note, email, search, command, everyday remark); for a passage, the register works, it flows, and every line stands alone as a clip.
- local: culturally right for the variety (names, places, prices, situations), no stereotypes.
Also flag names, cities or brands tacked on without a reason, formal, literary or Sanskritized words where people would say an everyday or English word, lines too long or tangled to read aloud calmly, anything sensitive or offensive, numbers with more than one plausible reading, English mixing that natives would not use (too much or too little), and lines that start or end mid-thought.

Politeness follows the listener, as natives really talk: familiar forms with friends, family, children and when speaking to a phone or computer; polite forms with strangers, elders, customers and at work. Do not "fix" a natural familiar form into a polite one.

verdict: "ok" if every score is at least 4 and nothing is flagged; "fix" if small edits make it excellent (then give the complete corrected item in "fixed", same number of lines); "drop" if it should be replaced.

Items:
${JSON.stringify(shown, null, 1)}

Answer with JSON: {"reviews": [{"id": "...", "natural": 1-5, "correct": 1-5, ${p.roman ? `"roman": 1-5, ` : ""}"fit": 1-5, "local": 1-5, "problems": "short note, empty if none", "verdict": "ok" | "fix" | "drop", "fixed": ${p.roman ? `{"native": [...], "roman": [...]}` : `{"native": [...]}`} or null}]}` },
  ];
}

export function repairPrompt(p: Profile, b: Brief, items: { item: Item; issues: string[] }[]): Msg[] {
  return [
    { role: "system", content: writerSystem(p) + briefBlock(p, b) },
    { role: "user", content: `These items failed automatic checks. Fix each one with the smallest change that solves every listed issue, keeping it natural. Line reading times are estimated from character counts (a sentence line should read in ${BOUNDS.sentence.min}-${BOUNDS.sentence.max} s, about ${size(p, 3, 20)}; a passage line ${BOUNDS.paraLine.min}-${BOUNDS.paraLine.max} s, about ${size(p, 5, 18)}; a passage ${BOUNDS.para.min}-${BOUNDS.para.max} s in total with ${BOUNDS.para.lines[0]}-${BOUNDS.para.lines[1]} lines). A line that is too long is best split into two lines (passages) or shortened (sentences).

${items.map(({ item, issues }) => JSON.stringify({ id: item.id, kind: item.kind, ...(item.title ? { title: item.title } : {}), native: item.native, ...(item.roman ? { roman: item.roman } : {}), issues })).join("\n")}

Answer with JSON: {"items": [{"id": "...", ${p.roman ? `"native": [...], "roman": [...]` : `"native": [...]`}}]}` },
  ];
}

export function diversityPrompt(p: Profile, b: Brief, items: Item[], maxDrop: number): Msg[] {
  const lines = items.map((x) => `${x.id}${x.title ? ` [${x.title}]` : ""}: ${x.native.join(" / ")}`).join("\n");
  return [
    { role: "system", content: reviewSystem(p, b) },
    { role: "user", content: `Here is the whole ${p.name} corpus (passages and sentences). Look for repetition that makes it less useful for training: the same names, places, foods, brands or content words (nouns, verbs, adjectives) used too often, a narrow vocabulary, the same openings (for example Hey, Please, Don't forget, Remind me), the same sentence templates, topics or situations, a register that dominates, or important everyday situations that are missing.

${lines}

Pick at most ${maxDrop} items to replace: the weakest members of over-represented groups (never passages unless they are clearly weak). Then write guidance for the replacements: what to use less, what to add.
Answer with JSON: {"drop": [{"id": "...", "reason": "..."}], "guidance": "..."}` },
  ];
}

export function spellingPrompt(p: Profile, b: Brief, groups: { key: string; spellings: Record<string, number> }[]): Msg[] {
  return [
    { role: "system", content: reviewSystem(p, b) },
    { role: "user", content: `In the romanized ${p.name} lines, these words are spelled more than one way (word: times used). For each group, decide whether the spellings are the same ${p.name} word (or the same English word). If they are, choose the one casual spelling to use everywhere, following the spelling guide when it covers the word, otherwise the most common casual spelling. If they are different words that only look alike, say so.

${groups.map((g, i) => `${i + 1}. ${Object.entries(g.spellings).map(([w, n]) => `${w}: ${n}`).join(", ")}`).join("\n")}

Answer with JSON: {"groups": [{"n": 1, "same": true | false, "use": "spelling" | null}]}` },
  ];
}

// ---------- synthesis pool ----------
// Thousands of extra lines per language for voice-cloned training speech (one take per distinct line).
// Breadth comes from a list of localized situations; each batch writes lines for a few of them.

export function situationsPrompt(p: Profile, b: Brief, cat: (typeof CATEGORIES)[number], n: number): Msg[] {
  return [
    { role: "system", content: writerSystem(p) + briefBlock(p, b) },
    { role: "user", content: `List ${n} distinct, concrete everyday situations in which ${p.name} speakers would dictate, type or say short lines to a phone or computer, all in this category: ${cat.what}
Each situation is a short English phrase naming who, what and where in a local setting (for example "texting a cousin about a delayed bus to the wedding venue", "asking the phone how much data is left this month").
Cover many walks of life: students, parents, shopkeepers, office workers, drivers, nurses, retirees, freelancers, farmers, teenagers; home, work, school, travel, health appointments, money, hobbies, sports, festivals, weather, repairs, pets, shopping, cooking, tech. No two situations alike.

Answer with JSON: {"situations": ["...", "..."]}` },
  ];
}

export function synthPrompt(p: Profile, b: Brief, situations: { category: string; situation: string }[], n: number, avoid: string[], pick: Parameters<typeof briefBlock>[2]): Msg[] {
  const short = Math.round(n * 0.2), long = Math.round(n * 0.2), mid = n - short - long;
  return [
    { role: "system", content: writerSystem(p) + briefBlock(p, b, pick) },
    { role: "user", content: `Write ${n} different lines that ${p.name} speakers would really dictate, type or say, about ${Math.round(n / situations.length)} for each of these situations:
${situations.map((s) => `- ${s.situation} (${CATEGORIES.find((c) => c.key === s.category)?.what ?? s.category})`).join("\n")}

Lengths: about ${short} short (${size(p, 4, 7)}), ${mid} medium (${size(p, 8, 14)}) and ${long} longer (${size(p, 15, 20)}). Each item is a single line.
Mix statements, questions, requests, lists said aloud and self-corrections (no wait, make that...). Use a wide vocabulary: new nouns, verbs and details in every line, never the same template twice. About a third of the lines mention a local name, place, dish, number or price where a speaker naturally would; the rest need none.

Lines already in the corpus look like these; do not repeat them, their ideas or their openings:
${avoid.map((s) => `- ${s}`).join("\n")}

Answer with JSON: {"sentences": [${p.roman ? `{"native": "...", "roman": "..."}` : `{"native": "..."}`}]}` },
  ];
}
