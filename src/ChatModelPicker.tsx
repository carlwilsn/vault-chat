// The composer's two small menus, beside Send: what THIS chat runs on, and how
// hard it thinks.
//
// Per chat, not per box (Carl: a picker in the composer, switchable mid-chat) —
// so a quick question can sit on Haiku while the chat next to it thinks on Opus.
// Real names only, no search box, no prices and no providers: four models and
// four levels is a list you read, not one you query.
//
// Always shown as plain labels ("Opus 5.5", "High"), no arrows; a label gets a
// subtle translucent rounded-rectangle highlight on hover, like a toolbar button,
// and a click opens its menu (Carl, 2026-11-08: not hidden until hover, not a pill).
import { useEffect, useRef, useState } from "react";
import { cn } from "./lib/utils";
import { useStore } from "./store";
import { defaultModel, EFFORTS, EFFORT_LABEL, labelFor, setChatModel, useChatModels, type Effort } from "./chatModels";

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
 * `convId`: the chat the picker sets. `model`/`effort`: what it is on now — the
 * conversation's own fields, or the box's default, in which case the menu shows
 * what is running rather than an empty label.
 */
export function ChatModelPicker({ convId, model, effort }: { convId: string | null; model?: string; effort?: Effort }) {
  const vault = useStore((s) => s.vaultPath);
  const models = useChatModels();
  const [error, setError] = useState<string | null>(null);
  if (!models.length || !convId) return null;
  // What it is on, which is not always a row: a chat that has chosen nothing runs
  // on the box's last choice, and one left on last generation's model keeps
  // running on that until he picks. Either way it is named as what it is.
  const on = model ?? defaultModel();
  const current = models.find((m) => m.id === on) ?? { id: on || models[0]!.id, name: labelFor(models, on) ?? models[0]!.name, efforts: models[0]!.efforts };
  const efforts = current.efforts.length ? EFFORTS.filter((e) => current.efforts.includes(e)) : [];
  const set = (patch: { model?: string; effort?: Effort | null }) =>
    void setChatModel(vault ?? "", convId, patch).then((e) => setError(e));

  return (
    <div data-el="chat-model-picker" className="flex items-center gap-1.5">
      <Menu
        el="chat-model"
        label={current.name}
        title={error ? `Not changed: ${error}` : `This chat runs on ${current.name}. A new chat starts on what you pick last.`}
      >
        {(close) =>
          models.map((m) => (
            <Row
              key={m.id}
              on={m.id === current.id}
              onClick={() => {
                close();
                if (m.id !== current.id) set({ model: m.id });
              }}
            >
              {m.name}
            </Row>
          ))
        }
      </Menu>
      {efforts.length > 0 && (
        <Menu el="chat-effort" label={effort ? EFFORT_LABEL[effort] : "Effort"} title={`How hard ${current.name} thinks in this chat`}>
          {(close) =>
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
          }
        </Menu>
      )}
    </div>
  );
}
