"use dom";

import "@zunos/ui/globals.css";

import { useSystemTheme } from "@zunos/ui/hooks/use-system-theme";
import { cn } from "@zunos/ui/lib/utils";
import { FlaskConical, GraduationCap, LogOut, Mic, Sparkles } from "lucide-react";
import { useState } from "react";

import type { Actions } from "../services/actions";
import type { LiveState } from "../shared/types";
import logo from "./assets/logo-256.png";
import Languages from "./screens/Languages";
import Record from "./screens/Record";
import SignIn from "./screens/SignIn";
import Test from "./screens/Test";
import Train from "./screens/Train";
import Use from "./screens/Use";
import { useAsync } from "./ui";

export type ScreenProps = { a: Actions; live: LiveState };

const NAV = [
  { id: "record", label: "Record", icon: Mic, Screen: Record },
  { id: "train", label: "Train", icon: GraduationCap, Screen: Train },
  { id: "test", label: "Test", icon: FlaskConical, Screen: Test },
  { id: "use", label: "Dictate", icon: Sparkles, Screen: Use },
] as const;

type Props = Actions & { live: LiveState; dom?: import("expo/dom").DOMProps };

export default function ZunosApp({ live, dom: _dom, ...a }: Props) {
  useSystemTheme();
  const langs = useAsync(() => a.languages(), [live.user?.id]);
  const [screen, setScreen] = useState<(typeof NAV)[number]["id"]>("record");
  const [editingLangs, setEditingLangs] = useState(false);

  if (!live.authReady || (live.user && !langs.data)) return <Splash />;
  if (!live.user) return <SignIn a={a as Actions} live={live} />;
  if (editingLangs || !langs.data!.some((l) => l.enabled))
    return (
      <Languages
        a={a as Actions}
        live={live}
        initial={langs.data!}
        onDone={async () => {
          await langs.reload();
          setEditingLangs(false);
        }}
      />
    );

  const { Screen } = NAV.find((n) => n.id === screen)!;
  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30 p-3">
        <div className="mb-6 flex items-center gap-2 px-2 pt-2">
          <img src={logo} alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">zunos</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setScreen(id)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                screen === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", screen === id && "text-brand")} />
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2 pb-1 text-xs text-muted-foreground">
          <EnginePill live={live} />
          <button className="text-left hover:text-foreground" onClick={() => setEditingLangs(true)}>
            Languages: {langs.data!.filter((l) => l.enabled).map((l) => l.name).join(", ")}
          </button>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{live.user.email}</span>
            <button title="Sign out" className="hover:text-foreground" onClick={() => a.signOut()}>
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        <Screen a={a as Actions} live={live} />
      </main>
    </div>
  );
}

function EnginePill({ live }: { live: LiveState }) {
  const label = {
    stopped: "Engine off", starting: "Starting engine…", loading: "Loading model…", ready: "Engine ready", busy: "Working…", error: "Engine error",
  }[live.engine];
  return (
    <span title={live.engineError ?? undefined} className="flex items-center gap-1.5">
      <span
        className={cn(
          "size-1.5 rounded-full",
          live.engine === "ready" && "bg-emerald-500",
          (live.engine === "starting" || live.engine === "loading" || live.engine === "busy") && "animate-pulse bg-amber-500",
          live.engine === "error" && "bg-destructive",
          live.engine === "stopped" && "bg-muted-foreground",
        )}
      />
      {label}
    </span>
  );
}

function Splash() {
  return (
    <div className="flex h-screen items-center justify-center">
      <img src={logo} alt="zunos" className="size-20 animate-pulse" />
    </div>
  );
}
