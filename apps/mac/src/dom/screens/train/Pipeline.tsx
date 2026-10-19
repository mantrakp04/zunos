import { cn } from "@zunos/ui/lib/utils";
import { motion } from "motion/react";

import type { LiveState, RunSummary, TrainingQuote } from "../../../shared/types";
import { Mascot, type MascotState } from "../../Mascot";

/**
 * One step of the trip a model takes. `where` groups it: packed and sent from this Mac, trained on a
 * rented GPU, brought back. The list comes from the run (or the quote, for the next run), so a new
 * pipeline (another voice engine, an extra check, two training passes) shows up without a UI change.
 */
export type Stage = { id: string; label: string; where: "mac" | "cloud"; title?: string };

/** Fields the pipeline may report; read loosely until RunSummary and TrainingQuote carry them. */
type WithStages = { stages?: Stage[] | null };
export type QuoteInfo = TrainingQuote & WithStages & { base?: string | null };

/** The stages until the run or the quote lists its own. */
export const DEFAULT_STAGES: Stage[] = [
  { id: "packing", label: "Pack", where: "mac", title: "Packing your recordings" },
  { id: "uploading", label: "Upload", where: "mac", title: "Uploading your recordings" },
  { id: "starting", label: "Start GPU", where: "cloud", title: "Starting a GPU" },
  { id: "data", label: "Prepare", where: "cloud", title: "Preparing your recordings" },
  { id: "setup", label: "Set up", where: "cloud", title: "Setting up the GPU" },
  { id: "gen", label: "Clone voice", where: "cloud", title: "Cloning your voice" },
  { id: "filter", label: "Check", where: "cloud", title: "Checking clip quality" },
  { id: "train", label: "Fine-tune", where: "cloud", title: "Fine-tuning on your voice" },
  { id: "export", label: "Package", where: "cloud", title: "Packaging the model" },
  { id: "upload", label: "Send back", where: "cloud", title: "Sending the model back" },
  { id: "downloading", label: "Download", where: "mac", title: "Downloading your model" },
  { id: "installing", label: "Install", where: "mac", title: "Installing" },
];

export function stagesOf(run: RunSummary | null, quote: QuoteInfo | null): Stage[] {
  const own = (run as (RunSummary & WithStages) | null)?.stages ?? quote?.stages;
  return own?.length ? own : DEFAULT_STAGES;
}

/** A stage's name for headings: its title, else its label. */
export const stageTitle = (s: Stage) => s.title ?? s.label;

export type TrackPos = { index: number; progress: number | null };

/** Where a run is on its stages. index = -1 when nothing is in flight; stages.length when installed. */
export function trackPos(stages: Stage[], run: RunSummary | null, transfer: LiveState["transfer"]): TrackPos {
  const at = (id: string) => stages.findIndex((s) => s.id === id);
  if (transfer) return { index: Math.max(0, at(transfer.phase)), progress: transfer.phase === "uploading" || transfer.phase === "downloading" ? transfer.progress : null };
  if (!run) return { index: -1, progress: null };
  if (run.stage === "downloaded") return { index: stages.length, progress: null };
  if (run.stage === "done") return { index: Math.max(0, at("downloading")), progress: null };
  const i = run.stage ? at(run.stage) : -1;
  if (i >= 0) return { index: i, progress: null };
  // Before the run reports a stage: the upload while it's uploading, else the first cloud stage.
  const firstCloud = Math.max(0, stages.findIndex((s) => s.where === "cloud"));
  return { index: run.status === "uploading" ? Math.max(0, firstCloud - 1) : firstCloud, progress: null };
}

/** Consecutive stages in the same place: This Mac, Cloud GPU, This Mac. */
function groupsOf(stages: Stage[]) {
  const out: { where: Stage["where"]; from: number; items: Stage[] }[] = [];
  stages.forEach((s, i) => {
    const g = out.at(-1);
    if (g && g.where === s.where) g.items.push(s);
    else out.push({ where: s.where, from: i, items: [s] });
  });
  return out;
}

/**
 * The stages as one line of segments, grouped by where they run. No row of labels to collide: each
 * segment names its stage on hover, and the stage in progress is named in the heading above.
 */
export function PipelineTrack({ stages, pos, live }: { stages: Stage[]; pos: TrackPos; live: boolean }) {
  const { index, progress } = pos;
  const idle = index < 0;
  const done = index >= stages.length;
  const mood: MascotState = idle ? "idle" : done ? "happy" : "thinking";
  const groups = groupsOf(stages);
  const current = groups.find((g) => index >= g.from && index < g.from + g.items.length);

  return (
    <div className="flex min-w-0 gap-3">
      {groups.map((g) => {
        const on = !!current && current === g;
        return (
          <div key={g.from} className="flex min-w-0 flex-col" style={{ flexGrow: g.items.length, flexBasis: 0 }}>
            <div className={cn("mb-1.5 truncate text-[10.5px] font-semibold tracking-[0.12em] uppercase transition-colors", on ? "text-brand" : "text-muted-foreground/80")}>
              {g.where === "cloud" ? "Cloud GPU" : "This Mac"}
            </div>
            <div className={cn("relative flex items-end gap-[3px]", idle ? "h-2" : "h-7")}>
              {g.items.map((s, k) => {
                const i = g.from + k;
                const state = idle ? "todo" : i < index || done ? "done" : i === index ? "now" : "todo";
                return (
                  <div key={s.id} title={stageTitle(s)} className="relative flex h-full min-w-0 flex-1 items-end">
                    {state === "now" && (
                      <motion.div layoutId="zt-bean" className="absolute bottom-2.5 left-1/2 -translate-x-1/2" transition={{ type: "spring", stiffness: 120, damping: 18 }}>
                        <Mascot state={mood} size={22} />
                      </motion.div>
                    )}
                    <span
                      className={cn(
                        "relative h-1.5 w-full overflow-hidden rounded-full transition-colors duration-500",
                        state === "done" ? "bg-brand" : state === "now" ? "bg-brand/25" : "bg-foreground/10",
                      )}
                    >
                      {state === "now" && (
                        <motion.span
                          className={cn("absolute inset-y-0 left-0 rounded-full bg-brand", live && progress == null && "zt-pulse")}
                          initial={false}
                          animate={{ width: `${(progress ?? 0.5) * 100}%` }}
                          transition={{ type: "spring", stiffness: 80, damping: 20 }}
                        />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
