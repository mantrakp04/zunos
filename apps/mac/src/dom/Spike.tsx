"use dom";

import "@zunos/ui/globals.css";

import { useEffect, useState } from "react";
import { VerificationInput } from "@zunos/ui/components/ruixen/verification-input";
import { useSystemTheme } from "@zunos/ui/hooks/use-system-theme";

export default function Spike({
  ping,
}: {
  ping: (msg: string) => Promise<string>;
  dom?: import("expo/dom").DOMProps;
}) {
  useSystemTheme();
  const [reply, setReply] = useState("waiting for native…");
  useEffect(() => {
    ping("hello from dom").then(setReply, (e) => setReply(`error: ${e}`));
  }, [ping]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">zunos</h1>
      <VerificationInput length={6} />
      <p className="max-w-xl text-center text-sm text-muted-foreground">{reply}</p>
    </div>
  );
}
