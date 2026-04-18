import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Check, Key, Cog, Code2 } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { MODELS, PROVIDER_LABEL, type ProviderId } from "./providers";
import { Button, Input, Select } from "./ui";
import { getMetaVaultPath } from "./meta";
import { gitInitIfNeeded } from "./git";

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "google"];

const KEY_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
};

export function SettingsPane() {
  const { apiKeys, serviceKeys, modelId, theme, setApiKey, setServiceKey, setModelId, setTheme, setShowSettings } = useStore();
  const setVault = useStore((s) => s.setVault);
  const setFiles = useStore((s) => s.setFiles);
  const setCurrentFile = useStore((s) => s.setCurrentFile);
  const vaultPath = useStore((s) => s.vaultPath);
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    anthropic: apiKeys.anthropic ?? "",
    openai: apiKeys.openai ?? "",
    google: apiKeys.google ?? "",
  });
  const [tavilyDraft, setTavilyDraft] = useState(serviceKeys.tavily ?? "");
  const [savedFlash, setSavedFlash] = useState<ProviderId | "tavily" | null>(null);

  const save = (p: ProviderId) => {
    const v = drafts[p].trim();
    if (v) {
      setApiKey(p, v);
      setSavedFlash(p);
      setTimeout(() => setSavedFlash((x) => (x === p ? null : x)), 1500);
    }
  };

  const saveTavily = () => {
    const v = tavilyDraft.trim();
    if (v) {
      setServiceKey("tavily", v);
      setSavedFlash("tavily");
      setTimeout(() => setSavedFlash((x) => (x === "tavily" ? null : x)), 1500);
    }
  };

  const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "not set");

  const openMetaVault = async () => {
    try {
      const meta = await getMetaVaultPath();
      if (meta === vaultPath) {
        setShowSettings(false);
        return;
      }
      setVault(meta);
      setCurrentFile(null, "");
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: meta });
      setFiles(listed);
      gitInitIfNeeded(meta).catch(() => {});
      setShowSettings(false);
    } catch (e) {
      console.error("[meta] open failed:", e);
    }
  };

  const openAppSource = async () => {
    try {
      const src = await invoke<string>("app_source_dir");
      if (src === vaultPath) {
        setShowSettings(false);
        return;
      }
      setVault(src);
      setCurrentFile(null, "");
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: src });
      setFiles(listed);
      gitInitIfNeeded(src).catch(() => {});
      setShowSettings(false);
    } catch (e) {
      console.error("[source] open failed:", e);
    }
  };

  return (
    <div className="h-full flex flex-col bg-card border-l border-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => setShowSettings(false)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[13px] font-semibold">Settings</span>
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-6">
        <section className="space-y-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Model
            </h3>
            <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
              The model used for chat. Requires a matching provider key.
            </p>
          </div>
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                [{PROVIDER_LABEL[m.provider]}] {m.label}
              </option>
            ))}
          </Select>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Theme
            </h3>
            <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
              App color palette.
            </p>
          </div>
          <Select value={theme} onChange={(e) => setTheme(e.target.value as "graphite" | "light")}>
            <option value="graphite">Graphite (default)</option>
            <option value="light">Light</option>
          </Select>
        </section>

        <div className="h-px bg-border" />

        {PROVIDERS.map((p) => (
          <section key={p} className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Key className="h-3 w-3" />
                  {PROVIDER_LABEL[p]}
                </h3>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5 font-mono">
                  {mask(apiKeys[p])}
                </p>
              </div>
              {savedFlash === p && (
                <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                  <Check className="h-3 w-3" /> saved
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={KEY_PLACEHOLDER[p]}
                value={drafts[p]}
                onChange={(e) => setDrafts({ ...drafts, [p]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save(p);
                }}
              />
              <Button size="sm" onClick={() => save(p)} disabled={!drafts[p].trim()}>
                Save
              </Button>
            </div>
          </section>
        ))}

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Key className="h-3 w-3" />
                Tavily (web search)
              </h3>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5 font-mono">
                {mask(serviceKeys.tavily)}
              </p>
            </div>
            {savedFlash === "tavily" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> saved
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="tvly-…"
              value={tavilyDraft}
              onChange={(e) => setTavilyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTavily();
              }}
            />
            <Button size="sm" onClick={saveTavily} disabled={!tavilyDraft.trim()}>
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Enables WebSearch. Get a free key at tavily.com.
          </p>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Cog className="h-3 w-3" />
              Agent internals (meta vault)
            </h3>
            <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 leading-relaxed">
              The agent's system prompt, skills, and custom tools live in a
              folder you can open as a vault and edit. The agent can edit it
              too. Every change is auto-committed to git so you can revert.
            </p>
          </div>
          <Button size="sm" onClick={openMetaVault}>
            Open meta vault
          </Button>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Code2 className="h-3 w-3" />
              App source
            </h3>
            <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 leading-relaxed">
              Open the vault-chat source folder as a vault. In dev mode (the
              standard way to run this app), changes hot-reload live —
              including changes the agent makes. Git-backed, so mistakes
              revert cleanly. For development use; not meaningful inside a
              packaged binary.
            </p>
          </div>
          <Button size="sm" onClick={openAppSource}>
            Open app source
          </Button>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Storage
          </h3>
          <p className="text-[11.5px] text-muted-foreground leading-relaxed">
            Keys and model preference are stored in <code className="font-mono bg-muted px-1 rounded text-[10.5px]">localStorage</code> on this machine.
            Clear browser storage to remove them. Keychain support is planned.
          </p>
        </section>
      </div>
    </div>
  );
}
