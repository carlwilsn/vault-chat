import { useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import {
  loadVaultNorthStar,
  saveVaultNorthStar,
  loadVaultSystemPrompt,
  saveVaultSystemPrompt,
  loadVaultVoicePrompt,
  saveVaultVoicePrompt,
  loadVaultSupervisorPrompt,
  saveVaultSupervisorPrompt,
  loadVaultAssistantPrompt,
  saveVaultAssistantPrompt,
} from "./meta";

// The agent's editable config for a vault, all under .vault-chat/agent/.
// Each tab is one file; Save writes whichever tabs changed.
type TabKey = "north" | "system" | "voice" | "assistant" | "supervisor";

const TABS: {
  key: TabKey;
  label: string;
  file: string;
  desc: string;
  placeholder: string;
  load: (vault: string) => Promise<string>;
  save: (vault: string, text: string) => Promise<void>;
}[] = [
  {
    key: "north",
    label: "North star",
    file: ".vault-chat/agent/north-star.md",
    desc: "Declare what this vault is for. The agent reads this before every turn — chat, voice, inline edit. Set the mode: tutor, co-engineer, from-scratch study, rapid build, anything.",
    placeholder:
      "e.g. This is my summer DL deep-dive vault. I'm hand-implementing transformers. Do NOT write code for me — push back and make me articulate where I'm stuck. Socratic tutor mode.",
    load: loadVaultNorthStar,
    save: saveVaultNorthStar,
  },
  {
    key: "system",
    label: "System prompt",
    file: ".vault-chat/agent/system.md",
    desc: "The agent's full base prompt for this vault. Seeded from the app default; edit it freely.",
    placeholder: "The base system prompt for this vault.",
    load: loadVaultSystemPrompt,
    save: saveVaultSystemPrompt,
  },
  {
    key: "voice",
    label: "Voice",
    file: ".vault-chat/agent/voice.md",
    desc: "How the agent talks in voice mode — tone, length, persona, speech rules. Seeded from the app default.",
    placeholder: "The voice-mode personality header for this vault.",
    load: loadVaultVoicePrompt,
    save: saveVaultVoicePrompt,
  },
  {
    key: "assistant",
    label: "Assistant",
    file: ".vault-chat/agent/assistant.md",
    desc: "The phone-cockpit chat — light and conversational. How it talks, when it just answers vs. proposes a mission for you to approve, and how it reads whether you want to learn something or offload it. Seeded from the app default.",
    placeholder: "The cockpit-assistant role for this vault.",
    load: loadVaultAssistantPrompt,
    save: saveVaultAssistantPrompt,
  },
  {
    key: "supervisor",
    label: "Supervisor",
    file: ".vault-chat/agent/supervisor.md",
    desc: "The always-on supervisor role — how it orchestrates missions and workers, paces its goal loop on self-scheduled wakes, and decides what reaches you. Layers on top of the system prompt for mission and background runs. Seeded from the app default.",
    placeholder: "The supervisor / mission-orchestration role for this vault.",
    load: loadVaultSupervisorPrompt,
    save: saveVaultSupervisorPrompt,
  },
];

const EMPTY: Record<TabKey, string> = { north: "", system: "", voice: "", assistant: "", supervisor: "" };

export function NorthStarModal({
  vault,
  open,
  onClose,
}: {
  vault: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [active, setActive] = useState<TabKey>("north");
  const [texts, setTexts] = useState<Record<TabKey, string>>(EMPTY);
  const [orig, setOrig] = useState<Record<TabKey, string>>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open || !vault) return;
    setActive("north");
    setLoaded(false);
    setError(null);
    void (async () => {
      const [north, system, voice, assistant, supervisor] = await Promise.all([
        loadVaultNorthStar(vault),
        loadVaultSystemPrompt(vault),
        loadVaultVoicePrompt(vault),
        loadVaultAssistantPrompt(vault),
        loadVaultSupervisorPrompt(vault),
      ]);
      const next: Record<TabKey, string> = { north, system, voice, assistant, supervisor };
      setTexts(next);
      setOrig(next);
      setLoaded(true);
      setTimeout(() => textareaRef.current?.focus(), 0);
    })();
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

  const dirtyKeys = TABS.filter((t) => texts[t.key] !== orig[t.key]).map((t) => t.key);
  const tab = TABS.find((t) => t.key === active)!;

  const save = async () => {
    if (!vault) return;
    setSaving(true);
    setError(null);
    try {
      // Persist every tab the user actually changed, not just the active one.
      for (const t of TABS) {
        if (texts[t.key] !== orig[t.key]) await t.save(vault, texts[t.key]);
      }
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
        className="w-[680px] max-h-[82vh] flex flex-col rounded-md border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <Compass className="h-4 w-4 text-primary" />
          <div className="text-[13px] font-semibold text-foreground">Agent config</div>
          {vault && (
            <div className="ml-auto text-[10.5px] text-muted-foreground font-mono truncate max-w-[240px]">
              {vault.split("/").filter(Boolean).pop()}
            </div>
          )}
        </div>

        <div className="px-4 flex items-center gap-1 border-b border-border/60">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`px-3 py-1.5 text-[12px] -mb-px border-b-2 transition-colors ${
                active === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {dirtyKeys.includes(t.key) && (
                <span className="ml-1 text-primary" title="unsaved changes">
                  •
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="px-4 pt-3 pb-2 text-[11.5px] text-muted-foreground leading-snug">
          {tab.desc} Stored at{" "}
          <span className="font-mono text-foreground/80">{tab.file}</span>, synced across machines
          via git.
        </div>

        <div className="flex-1 px-4 min-h-0">
          <textarea
            ref={textareaRef}
            value={texts[active]}
            onChange={(e) =>
              setTexts((prev) => ({ ...prev, [active]: e.target.value }))
            }
            disabled={!loaded || saving}
            placeholder={loaded ? tab.placeholder : "Loading…"}
            className="w-full h-[360px] resize-none rounded border border-border bg-background text-[12.5px] text-foreground p-2 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>

        {error && (
          <div className="px-4 pt-2 text-[11.5px] text-destructive">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-3 mt-2 border-t border-border/60">
          <div className="mr-auto text-[11px] text-muted-foreground">
            {dirtyKeys.length
              ? `${dirtyKeys.length} unsaved tab${dirtyKeys.length > 1 ? "s" : ""}`
              : "no changes"}
          </div>
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
            disabled={!loaded || saving || dirtyKeys.length === 0}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
