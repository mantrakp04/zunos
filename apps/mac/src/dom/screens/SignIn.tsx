import "./onboarding/onboarding.css";

import { cn } from "@zunos/ui/lib/utils";
import { ArrowLeft, ArrowRight, Loader2, Mail } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Wordmark } from "../Bean";
import { ErrorNote, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";
import { CodeTiles } from "./onboarding/CodeTiles";
import { Stage, type StageHandle } from "./onboarding/Stage";

const RESEND_AFTER = 30; // seconds
const ease = [0.22, 1, 0.36, 1] as const;

export default function SignIn({ a }: ScreenProps) {
  const stage = useRef<StageHandle>(null);
  const size = useBeanSize();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ email: string; nonce: string; at: number } | null>(null);
  const [code, setCode] = useState("");
  const [shake, setShake] = useState(0);

  const send = useAction(async (to: string) => {
    const { nonce } = await a.sendCode(to);
    setSent({ email: to, nonce, at: Date.now() });
    setCode("");
    stage.current?.poke(0.9);
  });
  const verify = useAction(async (c: string) => {
    try {
      await a.verifyCode(c, sent!.nonce);
    } catch (e) {
      setCode("");
      setShake((n) => n + 1);
      throw e;
    }
  });
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const busy = send.busy || verify.busy;

  return (
    <div className="relative flex h-screen overflow-hidden text-foreground select-none" style={{ "--sx": "28%" } as React.CSSProperties}>
      <div className="zn-stage-bg" />
      <div className="grain pointer-events-none absolute inset-0 opacity-70" />

      {/* the stage: the bean listens; every keystroke sends a ripple out of its ear */}
      <section className="relative flex w-[56%] items-center justify-center pt-[var(--titlebar)]">
        <motion.div
          initial={{ opacity: 0, scale: 0.86, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 170, damping: 18, delay: 0.05 }}
          className="-translate-x-[6%]"
        >
          <Stage ref={stage} size={size} mood={busy ? "thinking" : undefined} />
        </motion.div>
      </section>

      <section className="relative flex min-w-0 flex-1 items-center pt-[var(--titlebar)] pr-[clamp(32px,7vw,112px)]">
        <div className="w-full max-w-[400px]">
          <Wordmark height={40} draw className="text-brand-ink dark:text-brand-cream" />
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease, delay: 0.55 }}
            className="mt-6 font-display text-[23px] leading-[1.25] font-semibold tracking-[-0.015em] text-balance"
          >
            A speech model that learns your voice, in whatever languages you speak.{" "}
            <span className="text-muted-foreground">It runs on your Mac.</span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease, delay: 0.75 }}
            className="mt-9 min-h-[230px]"
          >
            <AnimatePresence mode="wait" initial={false}>
              {!sent ? (
                <motion.form
                  key="email"
                  initial={{ opacity: 0, x: -16, filter: "blur(4px)" }}
                  animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, x: -16, filter: "blur(4px)" }}
                  transition={{ duration: 0.28, ease }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (validEmail && !send.busy) send.run(email.trim());
                  }}
                >
                  <label htmlFor="zn-email" className="text-[12.5px] font-medium text-muted-foreground">
                    Sign in or create an account
                  </label>
                  <div
                    className={cn(
                      "mt-2.5 flex h-[56px] items-center rounded-[18px] bg-card pl-4 transition-shadow duration-200",
                      "shadow-[0_0_0_1px_var(--input),0_1px_2px_rgb(64_32_25/0.06),0_10px_30px_-18px_rgb(64_32_25/0.35)]",
                      "focus-within:shadow-[0_0_0_1.5px_var(--brand),0_0_0_5px_rgb(243_74_45/0.13),0_10px_30px_-18px_rgb(243_74_45/0.5)]",
                    )}
                  >
                    <Mail className="size-[18px] shrink-0 text-muted-foreground" />
                    <input
                      id="zn-email"
                      type="email"
                      autoFocus
                      autoComplete="email"
                      spellCheck={false}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        stage.current?.poke();
                      }}
                      placeholder="you@example.com"
                      className="h-full min-w-0 flex-1 bg-transparent px-3 text-[16px] outline-none placeholder:text-muted-foreground/60"
                    />
                    <motion.button
                      type="submit"
                      aria-label="Email me a sign-in code"
                      title="Email me a sign-in code"
                      disabled={!validEmail || send.busy}
                      animate={{ scale: validEmail ? 1 : 0.9 }}
                      whileTap={{ scale: 0.92 }}
                      transition={{ type: "spring", stiffness: 500, damping: 26 }}
                      className={cn(
                        "mr-[7px] grid size-[42px] shrink-0 place-items-center rounded-[13px] transition-[background,color,box-shadow] duration-200",
                        validEmail
                          ? "bg-[linear-gradient(180deg,#ff6a4a,var(--brand)_45%,var(--brand-deep))] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_6px_16px_-6px_rgb(243_74_45/0.8)]"
                          : "bg-foreground/[0.06] text-muted-foreground/60",
                      )}
                    >
                      {send.busy ? <Loader2 className="size-[18px] animate-spin" /> : <ArrowRight className="size-[19px]" strokeWidth={2.4} />}
                    </motion.button>
                  </div>
                  <p className="mt-3 px-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    We'll email you a 6-digit code. New here? The same code creates your account.
                  </p>
                  <ErrorNote error={send.error} className="mt-3" />
                </motion.form>
              ) : (
                <motion.div
                  key="code"
                  initial={{ opacity: 0, x: 16, filter: "blur(4px)" }}
                  animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, x: 16, filter: "blur(4px)" }}
                  transition={{ duration: 0.28, ease }}
                >
                  <h2 className="font-display text-[19px] font-semibold tracking-tight">Check your email</h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
                    Enter the code we sent to <span className="font-medium text-foreground select-text">{sent.email}</span>.
                  </p>
                  <CodeTiles
                    className="mt-5"
                    value={code}
                    onChange={(v) => {
                      setCode(v);
                      verify.setError(null);
                      stage.current?.poke(0.7);
                    }}
                    onComplete={(c) => verify.run(c)}
                    busy={verify.busy}
                    error={!!verify.error}
                    shakeKey={shake}
                  />
                  <div className="mt-4 min-h-[38px]">
                    {verify.busy ? (
                      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Signing in…
                      </p>
                    ) : (
                      <ErrorNote error={verify.error ?? send.error} />
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[13px]">
                    <button
                      type="button"
                      onClick={() => {
                        setSent(null);
                        setCode("");
                        verify.setError(null);
                        send.setError(null);
                      }}
                      disabled={busy}
                      className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-45"
                    >
                      <ArrowLeft className="size-3.5" /> Use a different email
                    </button>
                    <span className="text-muted-foreground/40">·</span>
                    <Resend sentAt={sent.at} busy={send.busy} disabled={verify.busy} onResend={() => send.run(sent.email)} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </section>
    </div>
  );
}

/** "Send a new code", after a short cooldown. Ticks on its own so the screen doesn't re-render. */
function Resend({ sentAt, busy, disabled, onResend }: { sentAt: number; busy: boolean; disabled: boolean; onResend: () => void }) {
  const [now, setNow] = useState(Date.now());
  const left = Math.max(0, RESEND_AFTER - Math.floor((now - sentAt) / 1000));
  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [left, sentAt]);
  return (
    <button
      type="button"
      onClick={onResend}
      disabled={left > 0 || busy || disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium text-brand transition-colors hover:bg-brand/10 disabled:font-normal disabled:text-muted-foreground disabled:hover:bg-transparent"
    >
      {busy && <Loader2 className="size-3.5 animate-spin" />}
      {left > 0 ? <span className="tabular-nums">Send a new code in 0:{String(left).padStart(2, "0")}</span> : "Send a new code"}
    </button>
  );
}

/** The bean scales with the window: big, but never crowding the form. */
function useBeanSize() {
  const pick = () => Math.round(Math.max(170, Math.min(window.innerHeight * 0.46, window.innerWidth * 0.26, 330)));
  const [size, setSize] = useState(pick);
  useEffect(() => {
    const on = () => setSize(pick());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}
