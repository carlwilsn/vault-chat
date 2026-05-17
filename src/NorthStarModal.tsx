import { useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import { loadVaultNorthStar, saveVaultNorthStar } from "./meta";

export function NorthStarModal({
  vault,
  open,
  onClose,
}: {
  vault: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open || !vault) return;
    setLoaded(false);
    setError(null);
    loadVaultNorthStar(vault).then((s) => {
      setText(s);
      setLoaded(true);
      setTimeout(() => textareaRef.current?.focus(), 0);
    });
  }, [open, vault]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    if (!vault) return;
    setSaving(true);
    setError(null);
    try {
      await saveVaultNorthStar(vault, text);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[640px] max-h-[80vh] flex flex-col rounded-md border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <Compass className="h-4 w-4 text-primary" />
          <div className="text-[13px] font-semibold text-foreground">North star</div>
        </div>
        <div className="px-4 pb-3 text-[11.5px] text-muted-foreground leading-snug">
          Declare what this vault is for. The agent reads this before every turn — chat, voice, inline edit. Use it to set the mode: tutor, co-engineer, from-scratch study, rapid build, anything. Stored at <span className="font-mono text-foreground/80">.vault-chat/north-star.md</span>.
        </div>
        <div className="flex-1 px-4 min-h-0">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!loaded || saving}
            placeholder={
              loaded
                ? "e.g. This is my summer DL deep-dive vault. I'm hand-implementing transformers. Do NOT write code for me. If I ask, push back and make me articulate where I'm stuck. Treat this as Socratic tutor mode."
                : "Loading…"
            }
            className="w-full h-[320px] resize-none rounded border border-border bg-background text-[12.5px] text-foreground p-2 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        {error && (
          <div className="px-4 pt-2 text-[11.5px] text-destructive">{error}</div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-3 mt-2 border-t border-border/60">
          <button
            className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={save}
            disabled={!loaded || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
