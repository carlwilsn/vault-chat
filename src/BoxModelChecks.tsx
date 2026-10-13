// Settings → Models, box mode: the models the box itself runs (its chat agent,
// the vision model it falls back to for images, the subagent child model) are
// checked on the box (GET /api/v1/models → box). Nothing shows while they all
// pass; a failing one gets the same quiet line as a picker's.
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { boxGet, boxLinkFor } from "./boxChat";

type BoxCheck = { id: string; state: "passed" | "missing" | "unknown"; missing?: string[] };
const ROLE = { chat: "Its chat model", vision: "Its vision model", subagent: "Its subagent model" } as const;
const NEED: Record<string, string> = { tools: "use tools", toolChoice: "take a tool choice", images: "see images", context: "hold a long chat (under 64k context)" };

export function BoxModelChecks() {
  const vault = useStore((s) => s.vaultPath);
  const on = useStore((s) => !!s.boxChat?.on);
  const [box, setBox] = useState<Record<string, BoxCheck> | null>(null);
  useEffect(() => {
    let alive = true;
    if (!on || !vault) {
      setBox(null);
      return;
    }
    void (async () => {
      const link = await boxLinkFor(vault);
      if (!link) return;
      const r = await boxGet(link, "/api/v1/models", 15_000).catch(() => null);
      if (alive && r && typeof r.box === "object" && r.box) setBox(r.box as Record<string, BoxCheck>);
    })();
    return () => {
      alive = false;
    };
  }, [on, vault]);
  if (!box) return null;
  const failing = (Object.keys(ROLE) as (keyof typeof ROLE)[]).filter((k) => box[k]?.state === "missing");
  if (!failing.length) return null;
  // A row like the pickers' (label, then the quiet line in the picker column).
  return (
    <div className="flex items-start justify-between gap-3" data-el="box-model-checks">
      <span className="text-[12px] text-foreground/90 shrink-0">Box</span>
      <div className="min-w-0 flex-1 max-w-[62%] space-y-0.5">
        {failing.map((k) => (
          <p key={k} className="text-[10.5px] text-amber-500/90 px-0.5">
            {ROLE[k]} ({box[k]!.id.split("/").pop()}) can't {(box[k]!.missing ?? []).map((n) => NEED[n] ?? n).join(" or ")}.
          </p>
        ))}
      </div>
    </div>
  );
}
