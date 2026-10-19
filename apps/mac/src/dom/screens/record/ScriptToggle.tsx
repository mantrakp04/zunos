import { cn } from "@zunos/ui/lib/utils";

import type { Language, Script } from "../../../shared/types";
import { scriptName } from "../../scripts";
import { langName, Segmented } from "../../ui";

/**
 * "Read in: देवनागरी / English letters" for a language that has both. What you pick is what you read
 * and what the model writes. Renders nothing for languages with only one script.
 */
export function ScriptToggle({ lang, script, onChange, disabled, className }: {
  lang: Pick<Language, "code" | "hasRoman">;
  script: Script;
  onChange: (s: Script) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (!lang.hasRoman) return null;
  const native = scriptName(lang.code);
  return (
    <span
      title={`Read and write ${langName(lang.code)} in ${script === "native" ? native : "English letters"}`}
      className={cn("inline-flex shrink-0", disabled && "pointer-events-none opacity-50", className)}
    >
      <Segmented<Script>
        size="sm"
        value={script}
        onChange={(s) => s !== script && onChange(s)}
        className="whitespace-nowrap"
        options={[
          { value: "native", label: <span lang={lang.code} className="font-display font-semibold">{native}</span> },
          { value: "roman", label: "English letters" },
        ]}
      />
    </span>
  );
}
