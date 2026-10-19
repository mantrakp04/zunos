import { cn } from "@zunos/ui/lib/utils";
import {
  AudioWaveform,
  Box,
  Check,
  CloudDownload,
  CloudUpload,
  Cpu,
  FolderOpen,
  Funnel,
  HardDriveDownload,
  type LucideIcon,
  Package,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { motion } from "motion/react";

import type { LiveState, RunSummary } from "../../../shared/types";
import { Bean, type BeanMood } from "../../Bean";

// The whole trip a model takes: packed on this Mac, trained on a rented GPU, then brought back.
// Remote stages come from the run (`stage`); the local ends come from `live.transfer`.
export const TRACK: { id: string; group: 0 | 1 | 2; label: string; icon: LucideIcon; title: string; desc: string }[] = [
  { id: "packing", group: 0, label: "Pack", icon: Package, title: "Packing your recordings", desc: "Bundling your clips and their text on this Mac." },
  { id: "uploading", group: 0, label: "Upload", icon: CloudUpload, title: "Uploading your recordings", desc: "Sending them to the training server." },
  { id: "starting", group: 1, label: "Start GPU", icon: Cpu, title: "Starting a GPU", desc: "Renting a cloud GPU and booting it." },
  { id: "data", group: 1, label: "Prepare", icon: FolderOpen, title: "Preparing your recordings", desc: "Unpacking your clips on the GPU." },
  { id: "setup", group: 1, label: "Set up", icon: Wrench, title: "Setting up the GPU", desc: "Installing the training tools." },
  { id: "gen", group: 1, label: "Clone voice", icon: AudioWaveform, title: "Cloning your voice", desc: "Your cloned voice reads thousands of new sentences." },
  { id: "filter", group: 1, label: "Check", icon: Funnel, title: "Checking clip quality", desc: "Dropping generated clips that don't sound like you." },
  { id: "train", group: 1, label: "Fine-tune", icon: SlidersHorizontal, title: "Fine-tuning Whisper", desc: "Training on your real clips and the cloned ones." },
  { id: "export", group: 1, label: "Package", icon: Box, title: "Packaging the model", desc: "Keeping the best step and packing it up." },
  { id: "upload", group: 1, label: "Send back", icon: CloudUpload, title: "Uploading the model", desc: "The GPU hands the finished model back." },
  { id: "downloading", group: 2, label: "Download", icon: CloudDownload, title: "Downloading your model", desc: "Bringing the model to this Mac." },
  { id: "installing", group: 2, label: "Install", icon: HardDriveDownload, title: "Installing", desc: "Unpacking it next to your other models." },
];
const GROUPS = ["This Mac", "Cloud GPU", "This Mac"];

export type TrackPos = { index: number; progress: number | null };

/** Where a run is on the track. index = -1 when nothing is in flight; TRACK.length when installed. */
export function trackPos(run: RunSummary | null, transfer: LiveState["transfer"]): TrackPos {
  if (transfer) {
    const i = TRACK.findIndex((t) => t.id === transfer.phase);
    return { index: i, progress: transfer.phase === "uploading" || transfer.phase === "downloading" ? transfer.progress : null };
  }
  if (!run) return { index: -1, progress: null };
  if (run.stage === "downloaded") return { index: TRACK.length, progress: null };
  if (run.stage === "done") return { index: TRACK.findIndex((t) => t.id === "downloading"), progress: null };
  const i = TRACK.findIndex((t) => t.id === run.stage);
  if (i >= 0) return { index: i, progress: null };
  return { index: run.status === "uploading" ? 1 : 2, progress: null };
}

const cx = (i: number) => ((i + 0.5) / TRACK.length) * 100;

export function PipelineTrack({ pos, live }: { pos: TrackPos; live: boolean }) {
  const { index, progress } = pos;
  const idle = index < 0;
  const fill = idle ? 0 : index >= TRACK.length ? cx(TRACK.length - 1) : cx(index);
  const beanAt = idle ? 0 : Math.min(index, TRACK.length - 1);
  const mood: BeanMood = idle ? "idle" : index >= TRACK.length ? "happy" : "thinking";

  return (
    <div className="@container relative">
      {/* group brackets */}
      <div className="relative mb-1 h-4">
        {GROUPS.map((g, gi) => {
          const ids = TRACK.map((t, i) => (t.group === gi ? i : -1)).filter((i) => i >= 0);
          const a = cx(ids[0]!) - 50 / TRACK.length + 0.6;
          const b = cx(ids[ids.length - 1]!) + 50 / TRACK.length - 0.6;
          const on = !idle && TRACK[Math.min(index, TRACK.length - 1)]!.group === gi && index < TRACK.length;
          return (
            <div key={gi} className="absolute top-0 flex h-4 items-center" style={{ left: `${a}%`, width: `${b - a}%` }}>
              <span className={cn("h-px flex-1 transition-colors", on ? "bg-brand/40" : "bg-foreground/10")} />
              <span
                className={cn(
                  "px-2 text-[10px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase transition-colors",
                  on ? "text-brand" : "text-muted-foreground/80",
                )}
              >
                {g}
              </span>
              <span className={cn("h-px flex-1 transition-colors", on ? "bg-brand/40" : "bg-foreground/10")} />
            </div>
          );
        })}
      </div>

      {/* the bean rides along */}
      <div className="relative h-11">
        <motion.div
          className="absolute bottom-0 -translate-x-1/2"
          initial={false}
          animate={{ left: `${cx(beanAt)}%` }}
          transition={{ type: "spring", stiffness: 90, damping: 16 }}
        >
          <motion.div animate={idle ? { y: 0 } : { y: [0, -3, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
            <Bean mood={mood} size={40} />
          </motion.div>
        </motion.div>
      </div>

      {/* rail + nodes */}
      <div className="relative h-10">
        <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground/[0.08]" style={{ left: `${cx(0)}%`, right: `${100 - cx(TRACK.length - 1)}%` }} />
        <motion.div
          className="absolute top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-[linear-gradient(90deg,var(--brand),var(--brand-gold))]"
          style={{ left: `${cx(0)}%` }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(0, fill - cx(0))}%` }}
          transition={{ type: "spring", stiffness: 60, damping: 18 }}
        >
          {live && <div className="zt-flow absolute inset-0 opacity-70 dark:opacity-40" />}
        </motion.div>
        {TRACK.map((t, i) => {
          const state = idle ? "todo" : i < index ? "done" : i === index ? "now" : "todo";
          const Icon = t.icon;
          return (
            <div key={t.id} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${cx(i)}%` }} title={`${t.title}. ${t.desc}`}>
              {state === "now" ? (
                <div className="relative grid size-10 place-items-center">
                  {live && (
                    <>
                      <span className="zt-ring" />
                      <span className="zt-ring" />
                      <span className="zt-ring" />
                    </>
                  )}
                  {progress != null && (
                    <svg className="absolute -inset-[5px] -rotate-90" viewBox="0 0 50 50">
                      <circle cx="25" cy="25" r="23" fill="none" stroke="var(--brand)" strokeOpacity={0.15} strokeWidth="2.5" />
                      <motion.circle
                        cx="25"
                        cy="25"
                        r="23"
                        fill="none"
                        stroke="var(--brand)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        initial={false}
                        animate={{ pathLength: progress }}
                        transition={{ type: "spring", stiffness: 80, damping: 20 }}
                      />
                    </svg>
                  )}
                  <motion.span
                    layoutId="zt-now"
                    className="relative grid size-10 place-items-center rounded-full bg-card text-brand shadow-[0_0_0_2px_var(--brand),0_6px_18px_-6px_rgb(243_74_45/0.6)]"
                  >
                    <Icon className="size-[18px]" strokeWidth={2.2} />
                  </motion.span>
                </div>
              ) : (
                <span
                  className={cn(
                    "grid size-7 place-items-center rounded-full transition-colors duration-500",
                    state === "done"
                      ? "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_2px_6px_-2px_rgb(243_74_45/0.6)]"
                      : "bg-card text-muted-foreground shadow-[0_0_0_1px_var(--input)]",
                  )}
                >
                  {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : <Icon className="size-3.5" strokeWidth={2} />}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* labels */}
      <div className="relative mt-2 h-8">
        {TRACK.map((t, i) => {
          const now = !idle && i === index;
          return (
            <div
              key={t.id}
              className={cn(
                "absolute top-0 flex -translate-x-1/2 flex-col items-center text-center whitespace-nowrap",
                !now && "@max-[34rem]:hidden",
              )}
              style={{ left: `${cx(i)}%` }}
            >
              <span
                className={cn(
                  "text-[11px] leading-tight @max-[46rem]:text-[10px] @max-[46rem]:tracking-[-0.01em]",
                  now ? "font-semibold text-foreground" : !idle && i < index ? "text-muted-foreground" : "text-muted-foreground/75",
                )}
              >
                {t.label}
              </span>
              {now && pos.progress != null && (
                <span className="text-[10.5px] font-medium tabular-nums text-brand">{Math.round(pos.progress * 100)}%</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
