import GravatarEmailInput from "@zunos/ui/components/ruixen/gravatar-email-input";
import { VerificationInput } from "@zunos/ui/components/ruixen/verification-input";
import { useState } from "react";

import logo from "../assets/logo-256.png";
import { Button, ErrorNote, useAction } from "../ui";
import type { ScreenProps } from "../ZunosApp";

export default function SignIn({ a }: ScreenProps) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ email: string; nonce: string } | null>(null);
  const send = useAction(async (to: string) => {
    const { nonce } = await a.sendCode(to);
    setSent({ email: to, nonce });
  });
  const verify = useAction((code: string) => a.verifyCode(code, sent!.nonce));
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <div className="flex h-screen items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img src={logo} alt="" className="size-24" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">zunos</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A speech model that learns your voice, in English, Hindi and Gujarati. It runs on your Mac.
          </p>
        </div>

        {!sent ? (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (validEmail) send.run(email.trim());
            }}
          >
            <GravatarEmailInput label="Email" placeholder="you@example.com" onChange={setEmail} sound={false} />
            <Button type="submit" variant="brand" loading={send.busy} disabled={!validEmail}>
              Email me a sign-in code
            </Button>
            <p className="text-xs text-muted-foreground">New here? The same code creates your account.</p>
            <ErrorNote error={send.error} />
          </form>
        ) : (
          <div className="flex w-full flex-col items-center gap-4">
            <p className="text-sm">
              Enter the 6-digit code sent to <span className="font-medium">{sent.email}</span>
            </p>
            <VerificationInput length={6} sound={false} onComplete={(code) => verify.run(code)} onResend={() => send.run(sent.email)} />
            {verify.busy && <p className="text-sm text-muted-foreground">Signing in…</p>}
            <ErrorNote error={verify.error ?? send.error} />
            <Button variant="ghost" onClick={() => setSent(null)}>
              Use a different email
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
