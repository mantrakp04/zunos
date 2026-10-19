import { WizardStepper } from "@zunos/ui/components/ruixen/wizard-stepper";
import { cn } from "@zunos/ui/lib/utils";
import { Check } from "lucide-react";
import { useState } from "react";

import type { Lang, Language } from "../../shared/types";
import { Button, ErrorNote, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";

const SAMPLES: Record<Lang, string> = {
  en: "Can you send me the updated deck before the call tomorrow?",
  hi: "Kal subah meeting hai, toh please deck raat tak bhej dena.",
  gu: "Kaale savaare meeting chhe, etle deck raat sudhi moklaavi dejo.",
};

const STEPS = [
  { id: "languages", title: "Languages", description: "What you speak" },
  { id: "record", title: "Record", description: "Read short passages" },
  { id: "train", title: "Train", description: "About an hour in the cloud" },
  { id: "dictate", title: "Dictate", description: "On your Mac, offline" },
];

export default function Languages({ a, initial, onDone }: ScreenProps & { initial: Language[]; onDone: () => void }) {
  const [picked, setPicked] = useState<Lang[]>(initial.filter((l) => l.enabled).map((l) => l.code));
  const save = useAction(async () => {
    await a.setLanguages(picked);
    onDone();
  });
  const toggle = (c: Lang) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <WizardStepper steps={STEPS} currentStep={0} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Which languages do you speak?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Hindi and Gujarati are written in English letters, the way you'd type them in a chat. You can switch languages mid-sentence.
        </p>
      </div>
      <div className="grid gap-3">
        {initial.map((l) => {
          const on = picked.includes(l.code);
          return (
            <button
              key={l.code}
              onClick={() => toggle(l.code)}
              className={cn(
                "flex items-center gap-4 rounded-xl border p-4 text-left transition-colors",
                on ? "border-brand bg-brand/5" : "hover:bg-accent",
              )}
            >
              <span className={cn("flex size-6 items-center justify-center rounded-full border", on && "border-brand bg-brand text-white")}>
                {on && <Check className="size-4" />}
              </span>
              <span className="flex flex-col">
                <span className="font-medium">{l.name}</span>
                <span className="text-sm text-muted-foreground">“{SAMPLES[l.code]}”</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="brand" disabled={!picked.length} loading={save.busy} onClick={() => save.run()}>
          Continue
        </Button>
        <ErrorNote error={save.error} />
      </div>
    </div>
  );
}
