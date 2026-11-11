// The composer's two small menus, beside Send: what THIS chat runs on, and how
// hard it thinks.
//
// One global setting, identical in every chat and on every device (Carl, 2026-11-10).
// Real names only, no search box, no prices and no providers: four models and
// four levels is a list you read, not one you query.
//
// Always shown as plain labels ("Opus 5.5", "High"), no arrows; a label gets a
// subtle translucent rounded-rectangle highlight on hover, like a toolbar button,
// and a click opens its menu (Carl, 2026-11-08: not hidden until hover, not a pill).
import { useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils";
import { useStore } from "./store";
import { EFFORTS, EFFORT_LABEL, labelFor, setChatModel, useChatModels, type Effort } from "./chatModels";

/** A menu that opens upwards over the composer, closing on a click outside. */
function Menu({ label, title, children, el }: { label: string; title: string; children: (close: () => void) => React.ReactNode; el: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        data-el={el}
        title={title}
        className={cn(
          "rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors",
          open && "bg-accent/60 text-foreground",
        )}
      >
        {label}
      </button>
      {open && <div className="absolute bottom-full left-0 mb-1 min-w-[9rem] rounded-lg border border-border bg-card shadow-lg z-50 py-1">{children(() => setOpen(false))}</div>}
    </div>
  );
}

const Row = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cn("block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors truncate", on ? "text-foreground font-medium" : "text-muted-foreground")}>
    {children}
  </button>
);

/**
 * `convId`: the chat the picker is open in (its running session takes a change at
 * once), or null on a new chat. Model and effort are the box's one global setting
 * (src/chatModels.ts), so this always renders: from the cache and a placeholder
 * name when the box has not answered yet.
 */
export function ChatModelPicker({ convId }: { convId: string | null }) {
  const vault = useStore((s) => s.vaultPath);
  const { models, model, effort } = useChatModels();
  const [error, setError] = useState<string | null>(null);
  // What it runs on, which is not always a row: a model left over from an earlier
  // generation keeps running until he picks, and is named as what it is.
  const first = models[0];
  const on = model || first?.id || "";
  const found = models.find((m) => m.id === on);
  const name = found?.name ?? labelFor(models, on) ?? "Model";
  const efforts = (found ?? first)?.efforts.length ? EFFORTS.filter((e) => (found ?? first)!.efforts.includes(e)) : [];
  const set = (patch: { model?: string; effort?: Effort | null }) =>
    void setChatModel(vault ?? "", convId, patch).then((e) => setError(e));

  return (
    <div data-el="chat-model-picker" className="flex items-center gap-1.5">
      <Menu
        el="chat-model"
        label={name}
        title={error ? `Not changed: ${error}` : `Every chat runs on ${name}.`}
      >
        {(close) =>
          models.length ? (
            models.map((m) => (
              <Row
                key={m.id}
                on={m.id === on}
                onClick={() => {
                  close();
                  if (m.id !== on) set({ model: m.id });
                }}
              >
                {m.name}
              </Row>
            ))
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground">Models load when the box answers</div>
          )
        }
      </Menu>
      <Menu el="chat-effort" label={effort ? EFFORT_LABEL[effort] : "Effort"} title={`How hard ${name} thinks, in every chat`}>
        {(close) =>
          efforts.length ? (
            efforts.map((e) => (
              <Row
                key={e}
                on={e === effort}
                onClick={() => {
                  close();
                  set({ effort: e === effort ? null : e });
                }}
              >
                {EFFORT_LABEL[e]}
              </Row>
            ))
          ) : (
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground">Levels load when the box answers</div>
          )
        }
      </Menu>
    </div>
  );
}
