import { WizardStepper } from "@zunos/ui/components/ruixen/wizard-stepper";
import { cn } from "@zunos/ui/lib/utils";
import { Check, Search } from "lucide-react";
import { useState } from "react";

import type { Lang, Language } from "../../shared/types";
import { Button, ErrorNote, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";

const STEPS = [
  { id: "languages", title: "Languages", description: "What you speak" },
  { id: "record", title: "Record", description: "Read short passages" },
  { id: "train", title: "Train", description: "About an hour in the cloud" },
  { id: "dictate", title: "Dictate", description: "On your Mac, offline" },
];

export default function Languages({ a, initial, onDone }: ScreenProps & { initial: Language[]; onDone: () => void }) {
  const [picked, setPicked] = useState<Lang[]>(initial.filter((l) => l.enabled).map((l) => l.code));
  const [query, setQuery] = useState("");
  const save = useAction(async () => {
    await a.setLanguages(picked);
    onDone();
  });
  const toggle = (c: Lang) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const q = query.trim().toLowerCase();
  const shown = initial.filter((l) => !q || l.name.toLowerCase().includes(q) || l.code === q);
  const romanized = initial.filter((l) => picked.includes(l.code) && l.script === "Latin (romanized)");

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 px-8 py-6">
      <WizardStepper steps={STEPS} currentStep={0} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Which languages do you speak?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick as many as you like; you can switch languages mid-sentence.
          {romanized.length > 0 && <> {romanized.map((l) => l.name).join(", ")} will be written in English letters, the way you'd type them in a chat.</>}
        </p>
      </div>
      <label className="flex items-center gap-2 rounded-lg border px-3">
        <Search className="size-4 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 99 languages"
          className="h-10 flex-1 bg-transparent text-sm outline-none"
        />
      </label>
      <div className="grid max-h-[17rem] grid-cols-3 gap-2 overflow-y-auto pr-1">
        {shown.map((l) => {
          const on = picked.includes(l.code);
          return (
            <button
              key={l.code}
              onClick={() => toggle(l.code)}
              className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors", on ? "border-brand bg-brand/5" : "hover:bg-accent")}
            >
              <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on && "border-brand bg-brand text-white")}>
                {on && <Check className="size-3" />}
              </span>
              {l.name}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="brand" disabled={!picked.length} loading={save.busy} onClick={() => save.run()}>
          Continue{picked.length > 0 && ` with ${picked.length} language${picked.length === 1 ? "" : "s"}`}
        </Button>
        <ErrorNote error={save.error} />
      </div>
    </div>
  );
}
