import { cn } from "@zunos/ui/lib/utils";
import { Check, PenLine, Search, X } from "lucide-react";
import { motion } from "motion/react";
import { memo, useMemo, useState } from "react";

import type { PromptItem } from "../../../shared/types";
import { Button, Eyebrow, langName, Meter, Segmented } from "../../ui";
import { type Group, GROUPS, groupOf } from "./model";

type Filter = "all" | Group;

/** Everything there is to read in this language, grouped by kind. Slides over the stage. */
export const Library = memo(function Library({ lang, prompts, selected, onSelect, onWrite, onClose }: {
  lang: string;
  prompts: PromptItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onWrite: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const done = prompts.filter((p) => p.recorded).length;

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GROUPS.map((g) => {
      const all = prompts.filter((p) => groupOf(p) === g.id);
      const shown = q ? all.filter((p) => p.lines.join(" ").toLowerCase().includes(q) || p.title?.toLowerCase().includes(q)) : all;
      return { ...g, all, shown, read: all.filter((p) => p.recorded).length };
    }).filter((s) => s.all.length && (filter === "all" || filter === s.id) && (!q || s.shown.length));
  }, [prompts, filter, query]);

  const present = GROUPS.filter((g) => prompts.some((p) => groupOf(p) === g.id));

  return (
    <>
      <motion.div
        className="absolute inset-0 z-20 bg-[rgb(42_23_18/0.2)] dark:bg-black/45"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: "104%" }}
        animate={{ x: 0 }}
        exit={{ x: "104%" }}
        transition={{ type: "spring", stiffness: 380, damping: 40 }}
        className="absolute top-2 right-2 bottom-2 z-30 flex w-[min(400px,calc(100%-48px))] flex-col overflow-hidden rounded-[20px] bg-card shadow-[0_0_0_1px_var(--border),0_24px_60px_-20px_rgb(42_23_18/0.45)]"
      >
        <div className="px-5 pt-[34px]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Eyebrow>Library · {langName(lang)}</Eyebrow>
              <div className="mt-1.5 font-display text-[22px] leading-none font-bold tracking-[-0.02em] tabular-nums">
                {done} <span className="text-muted-foreground">of {prompts.length} read</span>
              </div>
            </div>
            <button onClick={onClose} title="Close (Esc)" className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
          <Meter value={prompts.length ? done / prompts.length : 0} className="mt-3" />

          <div className="mt-4 flex items-center gap-2">
            <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3 text-[13px] focus-within:ring-2 focus-within:ring-ring/60">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.preventDefault();
                  if (query) setQuery("");
                  else onClose();
                }}
                placeholder="Find a line"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </label>
            <Button size="sm" variant="soft" onClick={onWrite}>
              <PenLine className="size-3.5" /> Write your own
            </Button>
          </div>
          {present.length > 1 && (
            <Segmented
              size="sm"
              className="mt-3 w-full [&>button]:flex-1"
              value={filter}
              onChange={setFilter}
              options={[{ value: "all" as Filter, label: "All" }, ...present.map((g) => ({ value: g.id as Filter, label: g.short }))]}
            />
          )}
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {sections.map((s) => (
            <section key={s.id} className="mb-2">
              <div className="sticky top-0 z-10 flex items-center justify-between bg-card/95 px-3 pt-3 pb-1.5 backdrop-blur">
                <span className="text-[12px] font-semibold">{s.label}</span>
                <span className="text-[11.5px] text-muted-foreground tabular-nums">
                  {s.read} of {s.all.length} read
                </span>
              </div>
              {s.shown.map((p) => (
                <Row key={p.id} p={p} on={p.id === selected} onSelect={onSelect} />
              ))}
            </section>
          ))}
          {!!prompts.length && !sections.length && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No line has “{query.trim()}”.</p>}
          {!prompts.length && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">Nothing here yet. Write something of your own to read.</p>}
        </div>
      </motion.aside>
    </>
  );
});

function Row({ p, on, onSelect }: { p: PromptItem; on: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      onClick={() => onSelect(p.id)}
      className={cn(
        "rk-row group relative flex w-full items-start gap-2.5 rounded-[12px] px-3 py-2 text-left text-[13px] leading-snug",
        on ? "bg-brand/10 dark:bg-brand/[0.09]" : "hover:bg-accent",
      )}
    >
      <span
        className={cn(
          "mt-[1px] grid size-4 shrink-0 place-items-center rounded-full",
          p.recorded ? "bg-good text-white" : "shadow-[inset_0_0_0_1.5px_var(--input)]",
        )}
      >
        {p.recorded && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2", on && "font-medium")}>{p.lines[0]}</span>
        {p.lines.length > 1 && <span className="mt-0.5 block text-[11.5px] text-muted-foreground">{p.lines.length} lines</span>}
      </span>
      {on && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-brand" />}
    </button>
  );
}
