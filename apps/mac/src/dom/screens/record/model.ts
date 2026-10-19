// Small pure helpers for the Record screen: grouping the library, labels, clocks.
import type { PromptItem } from "../../../shared/types";
import { ENOUGH_SECONDS, FULL_SECONDS } from "../../ui";

/** Speech per language that's enough to train: the dials fill toward it, then keep counting. */
export const GOAL_SECONDS = ENOUGH_SECONDS;
/** Where the dials' "more is better" arc tops out: a full set, the same one Start training fills toward. */
export const PLENTY_SECONDS = FULL_SECONDS;

export type Group = "own" | "para" | "twister" | "sentence";

export const GROUPS: { id: Group; label: string; short: string }[] = [
  { id: "own", label: "Your own", short: "Yours" },
  { id: "para", label: "Passages", short: "Passages" },
  { id: "twister", label: "Tongue twisters", short: "Twisters" },
  { id: "sentence", label: "Dictation sentences", short: "Sentences" },
];

/** Prompts the user wrote themselves (library.createPrompt ids). */
export const isOwn = (p: PromptItem) => p.id.startsWith("user-");

export const groupOf = (p: PromptItem): Group => (isOwn(p) ? "own" : p.kind);

/** Prompts of a group in list order. */
export const inGroup = (list: PromptItem[], g: Group) => list.filter((p) => groupOf(p) === g);

/** The heading shown above a prompt on the stage, e.g. "Sentence 12 of 304". */
export function promptLabel(p: PromptItem, list: PromptItem[]) {
  const g = groupOf(p);
  const same = inGroup(list, g);
  const n = same.findIndex((x) => x.id === p.id) + 1;
  if (g === "own") return { kind: "Your own", title: p.title ?? p.lines[0] ?? "" };
  if (g === "para") return { kind: "Passage", title: p.title ? cleanTitle(p.title) : `Passage ${n} of ${same.length}` };
  if (g === "twister") return { kind: "Tongue twister", title: `${n} of ${same.length}` };
  return { kind: "Sentence", title: `${n} of ${same.length}` };
}

// Built-in titles carry a note the language dial already says ("(typed in English)").
const cleanTitle = (t: string) => t.replace(/\s*\(typed in [^)]*\)\s*$/i, "");

export const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Same split as library.createPrompt, for the live "N lines" count while writing. */
export const splitLines = (text: string) =>
  text
    .split(/(?<=[.!?।॥。！？])\s+|\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

