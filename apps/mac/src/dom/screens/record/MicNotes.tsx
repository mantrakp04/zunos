import { cn } from "@zunos/ui/lib/utils";
import { AlertTriangle, Mic } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo } from "react";

import type { MicDeviceInfo, MicIssue, MicIssueCode } from "../../../shared/types";

/** Issues that make every take worse until the mic changes: shown loud, before you start. */
const LOUD: MicIssueCode[] = ["noInput", "bluetooth", "narrowband", "continuity", "virtualDevice"];

const actionable = (issues: MicIssue[]) => issues.filter((i) => i.severity !== "info");
const tipOf = (issues: MicIssue[]) => issues.map((i) => `${i.title}. ${i.detail}`).join("\n");

/**
 * Before a take: the mic zunos will record with, and what's wrong with it. A Bluetooth or low-quality
 * mic gets the warning colour and the title in full; it never blocks starting.
 */
export const MicLine = memo(function MicLine({ device, issues }: { device: MicDeviceInfo | null; issues: MicIssue[] }) {
  const shown = actionable(issues);
  const worst = shown[0];
  const loud = !!worst && (LOUD.includes(worst.code) || worst.severity === "bad");
  return (
    <div title={tipOf(shown) || undefined} className={cn("flex min-w-0 items-center gap-2 text-[12.5px]", loud ? "text-destructive" : "text-muted-foreground")}>
      {loud ? <AlertTriangle className="size-3.5 shrink-0" strokeWidth={2.4} /> : <Mic className="size-3.5 shrink-0" />}
      <span className={cn("shrink-0 truncate", loud ? "max-w-[12rem] font-medium" : "max-w-[16rem]")}>{device?.name ?? "No microphone"}</span>
      {worst && (
        <span className={cn("min-w-0 truncate", loud ? "font-semibold" : "text-foreground/75")}>
          · {worst.title}
          {shown.length > 1 && <span className="font-normal text-muted-foreground"> +{shown.length - 1}</span>}
        </span>
      )}
    </div>
  );
});

/**
 * During a take, next to REC: "Stay quiet" while the room tone is measured, then the worst current
 * issue (too quiet, too loud, clipping, a noisy room) as one short word chip. Nothing when all is well.
 */
export const LiveMicIssue = memo(function LiveMicIssue({ roomTone, issues }: { roomTone: boolean; issues: MicIssue[] }) {
  const worst = actionable(issues)[0];
  const key = roomTone ? "quiet" : (worst?.code ?? null);
  return (
    <AnimatePresence mode="wait" initial={false}>
      {key && (
        <motion.span
          key={key}
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4, transition: { duration: 0.12 } }}
          transition={{ duration: 0.18 }}
          title={roomTone ? undefined : worst && `${worst.title}. ${worst.detail}`}
          className={cn(
            "flex h-7 max-w-[15rem] min-w-0 items-center rounded-full px-3 text-[12px] font-medium whitespace-nowrap",
            roomTone ? "bg-foreground/[0.06] text-muted-foreground" : worst?.severity === "bad" ? "bg-destructive/12 text-destructive" : "bg-warn/14 text-warn",
          )}
        >
          <span className="truncate">{roomTone ? "Stay quiet…" : worst!.title}</span>
        </motion.span>
      )}
    </AnimatePresence>
  );
});
