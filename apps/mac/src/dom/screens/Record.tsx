import LiveWaveform from "@zunos/ui/components/ruixen/live-waveform";
import { cn } from "@zunos/ui/lib/utils";
import { CheckCircle2, Circle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Lang, PromptItem, SavedRecording } from "../../shared/types";
import { Badge, Button, Card, ErrorNote, LANG_NAMES, minutes, PageHeader, useAction, useAsync } from "../ui";
import type { ScreenProps } from "../ZunosApp";

// Rough amount of your own speech per language that makes a noticeable difference.
const GOAL_SECONDS = 10 * 60;

export default function Record({ a, live }: ScreenProps) {
  const langs = useAsync(() => a.languages());
  const stats = useAsync(() => a.stats());
  const enabled = (langs.data ?? []).filter((l) => l.enabled);
  const [lang, setLang] = useState<Lang | null>(null);
  const current = lang ?? enabled[0]?.code ?? null;
  const prompts = useAsync(() => (current ? a.prompts(current) : Promise.resolve([])), [current]);
  const [selected, setSelected] = useState<string | null>(null);
  const prompt = prompts.data?.find((p) => p.id === selected) ?? prompts.data?.find((p) => !p.recorded) ?? prompts.data?.[0] ?? null;

  return (
    <div>
      <PageHeader title="Record" subtitle="Read each passage at your normal pace, the way you'd actually talk. Every take becomes training data; about a quarter is kept aside to test the model fairly." />

      <div className="mb-6 grid grid-cols-3 gap-3">
        {enabled.map((l) => {
          const s = stats.data?.find((x) => x.lang === l.code);
          const total = (s?.trainSeconds ?? 0) + (s?.testSeconds ?? 0);
          return (
            <button
              key={l.code}
              onClick={() => (setLang(l.code), setSelected(null))}
              className={cn("rounded-xl border p-4 text-left transition-colors", current === l.code ? "border-brand bg-brand/5" : "hover:bg-accent")}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{l.name}</span>
                <span className="text-xs text-muted-foreground">{minutes(total)}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, (total / GOAL_SECONDS) * 100)}%` }} />
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {s?.trainClips ?? 0} training · {s?.testClips ?? 0} test clips
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[18rem_1fr] gap-6">
        <PromptList prompts={prompts.data ?? []} selected={prompt?.id ?? null} onSelect={setSelected} disabled={live.recording} />
        {prompt ? (
          <Take
            key={prompt.id}
            prompt={prompt}
            a={a}
            live={live}
            onSaved={() => {
              prompts.reload();
              stats.reload();
            }}
          />
        ) : (
          <Card>No passages for this language.</Card>
        )}
      </div>
    </div>
  );
}

function PromptList({ prompts, selected, onSelect, disabled }: { prompts: PromptItem[]; selected: string | null; onSelect: (id: string) => void; disabled: boolean }) {
  const done = prompts.filter((p) => p.recorded).length;
  return (
    <div className="flex max-h-[calc(100vh-18rem)] flex-col overflow-hidden rounded-xl border">
      <div className="border-b px-3 py-2 text-xs text-muted-foreground">
        {done} of {prompts.length} read
      </div>
      <div className="overflow-y-auto p-1">
        {prompts.map((p) => (
          <button
            key={p.id}
            disabled={disabled}
            onClick={() => onSelect(p.id)}
            className={cn(
              "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm disabled:opacity-60",
              selected === p.id ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            {p.recorded ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
            <span className="line-clamp-2">{p.title ?? p.lines[0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Take({ prompt, a, live, onSaved }: ScreenProps & { prompt: PromptItem; onSaved: () => void }) {
  const [line, setLine] = useState(-1); // -1: not started
  const [saved, setSaved] = useState<SavedRecording | null>(null);
  const start = useAction(async () => {
    setSaved(null);
    await a.startTake(prompt.id);
    setLine(0);
  });
  const finish = useAction(async () => {
    const res = await a.finishTake();
    setLine(-1);
    setSaved(res);
    onSaved();
  });
  const recording = line >= 0;
  const last = line === prompt.lines.length - 1;

  const next = () => {
    if (!recording) return start.run();
    if (last) return finish.run();
    a.markLine();
    setLine((l) => l + 1);
  };
  const cancel = async () => {
    await a.cancelTake();
    setLine(-1);
  };

  // Space: start / next line. Enter: finish. Escape: discard.
  const keys = useRef({ next, cancel, finish: () => recording && finish.run() });
  keys.current = { next, cancel, finish: () => recording && finish.run() };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") (e.preventDefault(), keys.current.next());
      else if (e.code === "Enter") keys.current.finish();
      else if (e.code === "Escape") keys.current.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Badge tone="brand">{LANG_NAMES[prompt.lang]}</Badge>
        <Badge>{prompt.kind === "para" ? "Passage" : prompt.kind === "twister" ? "Tongue twister" : "Sentence"}</Badge>
        {prompt.recorded && <Badge tone="good">Recorded before</Badge>}
      </div>

      <div className="flex flex-col gap-3 text-lg leading-relaxed">
        {prompt.lines.map((l, i) => (
          <p
            key={i}
            className={cn(
              "transition-colors",
              !recording && "text-foreground",
              recording && i === line && "text-foreground",
              recording && i < line && "text-muted-foreground/50",
              recording && i > line && "text-muted-foreground",
            )}
          >
            {recording && i === line && <span className="mr-2 inline-block size-2 -translate-y-0.5 rounded-full bg-brand" />}
            {l}
          </p>
        ))}
      </div>

      <LiveWaveform active={live.recording} processing={finish.busy} level={live.recording ? live.level : undefined} height={40} barColor="var(--brand)" />

      <div className="flex items-center gap-3">
        {!recording ? (
          <Button variant="brand" onClick={() => start.run()} loading={start.busy || finish.busy}>
            {finish.busy ? "Saving…" : prompt.recorded ? "Record again" : "Start reading"}
          </Button>
        ) : (
          <>
            <Button variant="brand" onClick={next}>
              {last ? "Done" : "Next line"}
            </Button>
            <Button variant="ghost" onClick={cancel}>
              Discard
            </Button>
          </>
        )}
        <span className="text-xs text-muted-foreground">
          {recording ? "Space: next line · Enter: done · Esc: discard" : "Space to start"}
        </span>
      </div>

      <ErrorNote error={start.error ?? finish.error} />

      {saved && (
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <p className="font-medium">
            Saved {minutes(saved.seconds)} as {saved.clips.length} clip{saved.clips.length === 1 ? "" : "s"}.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
            {saved.clips.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <Badge tone={c.split === "test" ? "warn" : "muted"}>{c.split === "test" ? "test" : "train"}</Badge>
                <span className="tabular-nums">{c.seconds.toFixed(1)} s</span>
                <span className="truncate">{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
