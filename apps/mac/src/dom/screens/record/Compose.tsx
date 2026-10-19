import { useState } from "react";

import type { Lang, PromptItem } from "../../../shared/types";
import { Button, ErrorNote, langName, useAction } from "../../ui";
import type { ScreenProps } from "../../ZunosApp";
import { splitLines } from "./model";

/** A passage the user writes or pastes, written right on the stage. */
export function Compose({ lang, a, onCreated, onCancel }: {
  lang: Lang;
  a: ScreenProps["a"];
  onCreated: (p: PromptItem) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const save = useAction(async () => onCreated(await a.createPrompt(lang, text)));
  const n = splitLines(text).length;
  return (
    <div className="absolute inset-0 flex flex-col px-8 pt-2 pb-4 [container-type:size]">
      <p className="mx-auto w-full max-w-[44rem] text-[13px] leading-relaxed text-muted-foreground">
        Something you'd actually dictate in {langName(lang)}: a message, a note, an email. Type it the way you'd normally write it, in whatever
        letters you use. Each sentence becomes a line.
      </p>
      <textarea
        autoFocus
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey && text.trim()) (e.preventDefault(), save.run());
          else if (e.key === "Escape" && onCancel) (e.preventDefault(), onCancel());
        }}
        placeholder="Hey, running ten minutes late. Can you start the meeting without me?"
        className="mx-auto mt-3 w-full max-w-[44rem] min-h-0 flex-1 resize-none bg-transparent font-display text-[clamp(17px,2.6cqi,22px)] leading-[1.5] tracking-[-0.01em] outline-none placeholder:text-muted-foreground/50"
      />
      <div className="mx-auto flex w-full max-w-[44rem] items-center gap-3 pt-2">
        <span className="text-[12px] text-muted-foreground tabular-nums">{n ? `${n} line${n === 1 ? "" : "s"}` : "Nothing yet"}</span>
        <ErrorNote error={save.error} className="min-w-0 flex-1" />
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="brand" size="sm" disabled={!text.trim()} loading={save.busy} onClick={() => save.run()}>
            Save and read it <span className="text-[11px] opacity-75">⌘↩</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
