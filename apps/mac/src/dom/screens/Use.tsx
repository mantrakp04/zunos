import LiveWaveform from "@zunos/ui/components/ruixen/live-waveform";
import { cn } from "@zunos/ui/lib/utils";
import { Copy, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge, Card, ErrorNote, LANG_NAMES, PageHeader, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";

type Result = { text: string; lang: string; seconds: number; elapsed: number };

export default function Use({ a, live }: ScreenProps) {
  const [history, setHistory] = useState<Result[]>([]);
  const prepare = useAction(() => a.prepareDictation());
  const start = useAction(() => a.startDictation());
  const stop = useAction(async () => {
    const r = await a.stopDictation();
    setHistory((h) => [r, ...h].slice(0, 20));
  });

  useEffect(() => {
    prepare.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => (live.recording ? stop.run() : start.run());
  const keys = useRef(toggle);
  keys.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) (e.preventDefault(), keys.current());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loading = prepare.busy || live.engine === "loading" || live.engine === "starting";
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Dictate" subtitle="Talk, then stop. The text is copied to your clipboard. Mix languages freely." />

      <Card className="flex flex-col items-center gap-5 py-10">
        <button
          onClick={toggle}
          disabled={loading || stop.busy}
          className={cn(
            "flex size-24 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95 disabled:opacity-50",
            live.recording ? "bg-brand-deep" : "bg-brand hover:scale-105",
          )}
        >
          {live.recording ? <Square className="size-8" fill="currentColor" /> : <Mic className="size-9" />}
        </button>
        <LiveWaveform active={live.recording} processing={stop.busy} level={live.recording ? live.level : undefined} height={36} className="w-full max-w-md" barColor="var(--brand)" />
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading your model…" : stop.busy ? "Transcribing…" : live.recording ? "Listening… press Space to stop" : "Press Space or the button to talk"}
        </p>
        <ErrorNote error={prepare.error ?? start.error ?? stop.error} />
      </Card>

      <div className="mt-6 flex flex-col gap-3">
        {history.map((r, i) => (
          <Card key={history.length - i} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge>{LANG_NAMES[r.lang as keyof typeof LANG_NAMES] ?? r.lang}</Badge>
              <span>
                {r.seconds.toFixed(1)} s of speech in {r.elapsed.toFixed(1)} s
              </span>
              {i === 0 && <Badge tone="good">copied</Badge>}
              <button className="ml-auto hover:text-foreground" title="Copy" onClick={() => a.copyText(r.text)}>
                <Copy className="size-3.5" />
              </button>
            </div>
            <p className="select-text">{r.text || <span className="text-muted-foreground">(nothing heard)</span>}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
