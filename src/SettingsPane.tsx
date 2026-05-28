import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  Check,
  Key,
  Cog,
  X,
  Plus,
  Lock,
  Shield,
  RefreshCw,
  Send,
  Monitor,
} from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { PROVIDER_LABEL, type ProviderId } from "./providers";
import { Button, Input, Select } from "./ui";
import { getMetaVaultPath } from "./meta";
import { gitInitIfNeeded } from "./git";
import { stopAgent } from "./chat-controller";
import { listUserKeys, setUserKey, deleteUserKey } from "./keychain";
import {
  readVaultSyncConfig,
  writeVaultSyncConfig,
  setVaultRemote,
  vaultCommitLocal,
  vaultPush,
  vaultPull,
  vaultGhCreateRepo,
  subscribeSyncStatus,
  startVaultSyncLoop,
  stopVaultSyncLoop,
  DEFAULT_SYNC_CONFIG,
  type VaultSyncConfig,
} from "./vaultSync";
import {
  getTelegramCredentials,
  setTelegramCredentials,
  clearTelegramCredentials,
  startTelegramService,
  stopTelegramService,
  testTelegramConnection,
  subscribeTelegramStatus,
  readTelegramEnabled,
  writeTelegramEnabled,
  refreshTelegramSnapshot,
  getTelegramModelId,
  setTelegramModelId,
  type TelegramSnapshot,
} from "./telegram";
import {
  readCrossSyncConfig,
  writeCrossSyncConfig,
  startCrossSync,
  stopCrossSync,
  subscribeCrossSyncStatus,
  probeTailscaleHostname,
  type CrossSyncConfig,
  type CrossSyncSnapshot,
} from "./crossSync";
const PROVIDERS: ProviderId[] = ["anthropic", "openai", "google", "openrouter"];

const KEY_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
  openrouter: "sk-or-…",
};

export function SettingsPane() {
  const {
    apiKeys,
    serviceKeys,
    modelId,
    theme,
    setApiKey,
    clearApiKey,
    setServiceKey,
    clearServiceKey,
    setModelId,
    setTheme,
    strictVaultMode,
    bashDisabled,
    setStrictVaultMode,
    setBashDisabled,
    setShowSettings,
    catalog,
    catalogRefreshing,
    catalogErrors,
    refreshCatalog,
  } = useStore();
  const setVault = useStore((s) => s.setVault);
  const setFiles = useStore((s) => s.setFiles);
  const setCurrentFile = useStore((s) => s.setCurrentFile);
  const vaultPath = useStore((s) => s.vaultPath);
  const [modelSearch, setModelSearch] = useState("");
  const filteredCatalog = (() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return catalog;
    const terms = q.split(/\s+/);
    return catalog.filter((m) => {
      const hay = `${m.provider} ${m.id} ${m.label}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  })();
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    anthropic: apiKeys.anthropic ?? "",
    openai: apiKeys.openai ?? "",
    google: apiKeys.google ?? "",
    openrouter: apiKeys.openrouter ?? "",
  });
  const [tavilyDraft, setTavilyDraft] = useState(serviceKeys.tavily ?? "");
  const [elevenlabsDraft, setElevenlabsDraft] = useState(serviceKeys.elevenlabs ?? "");
  const [elevenlabsVoiceDraft, setElevenlabsVoiceDraft] = useState(
    localStorage.getItem("vault_chat_elevenlabs_voice") ?? "nPczCjzI2devNBz1zQrb",
  );
  const [voiceLibrary, setVoiceLibrary] = useState<{ name: string; id: string }[]>(() => {
    const raw = localStorage.getItem("vault_chat_elevenlabs_voice_library");
    if (!raw) return [{ name: "Brian (Jarvis-adjacent)", id: "nPczCjzI2devNBz1zQrb" }];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [newVoiceName, setNewVoiceName] = useState("");
  const [newVoiceId, setNewVoiceId] = useState("");
  const voicePickerRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = voicePickerRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        el.open = false;
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const [elevenlabsLlmDraft, setElevenlabsLlmDraft] = useState(
    localStorage.getItem("vault_chat_elevenlabs_llm") ?? "gemini-2.5-flash",
  );
  const [savedFlash, setSavedFlash] = useState<
    | ProviderId
    | "tavily"
    | "elevenlabs"
    | "elevenlabs_voice"
    | "elevenlabs_llm"
    | null
  >(null);

  const save = (p: ProviderId) => {
    const v = drafts[p].trim();
    if (!v) return;
    setApiKey(p, v);
    // Keep the draft populated so type=password keeps showing dots —
    // an empty input after save reads as "nothing saved." A small
    // refresh delay lets the saved-flash animate before models reload.
    setDrafts((d) => ({ ...d, [p]: v }));
    setSavedFlash(p);
    setTimeout(() => setSavedFlash((x) => (x === p ? null : x)), 1500);
    setTimeout(() => refreshCatalog(), 500);
  };

  const remove = (p: ProviderId) => {
    clearApiKey(p);
    setDrafts((d) => ({ ...d, [p]: "" }));
  };

  const saveTavily = () => {
    const v = tavilyDraft.trim();
    if (!v) return;
    setServiceKey("tavily", v);
    setTavilyDraft(v);
    setSavedFlash("tavily");
    setTimeout(() => setSavedFlash((x) => (x === "tavily" ? null : x)), 1500);
  };

  const saveElevenlabs = () => {
    const v = elevenlabsDraft.trim();
    if (!v) return;
    setServiceKey("elevenlabs", v);
    setElevenlabsDraft(v);
    setSavedFlash("elevenlabs");
    setTimeout(() => setSavedFlash((x) => (x === "elevenlabs" ? null : x)), 1500);
  };

  const removeElevenlabs = () => {
    clearServiceKey("elevenlabs");
    setElevenlabsDraft("");
  };

  const saveElevenlabsVoice = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed) return;
    localStorage.setItem("vault_chat_elevenlabs_voice", trimmed);
    setElevenlabsVoiceDraft(trimmed);
    setSavedFlash("elevenlabs_voice");
    setTimeout(
      () => setSavedFlash((x) => (x === "elevenlabs_voice" ? null : x)),
      1500,
    );
  };

  const addVoiceToLibrary = () => {
    const name = newVoiceName.trim();
    const id = newVoiceId.trim();
    if (!name || !id) return;
    const next = [...voiceLibrary.filter((v) => v.id !== id), { name, id }];
    setVoiceLibrary(next);
    localStorage.setItem("vault_chat_elevenlabs_voice_library", JSON.stringify(next));
    setNewVoiceName("");
    setNewVoiceId("");
    saveElevenlabsVoice(id);
  };

  const removeVoiceFromLibrary = (id: string) => {
    const next = voiceLibrary.filter((v) => v.id !== id);
    setVoiceLibrary(next);
    localStorage.setItem("vault_chat_elevenlabs_voice_library", JSON.stringify(next));
  };

  const saveElevenlabsLlm = (v: string) => {
    localStorage.setItem("vault_chat_elevenlabs_llm", v);
    setElevenlabsLlmDraft(v);
    setSavedFlash("elevenlabs_llm");
    setTimeout(
      () => setSavedFlash((x) => (x === "elevenlabs_llm" ? null : x)),
      1500,
    );
  };

  const removeTavily = () => {
    clearServiceKey("tavily");
    setTavilyDraft("");
  };

  // --- your keys (custom user-managed credentials) ---
  const [userKeyNames, setUserKeyNames] = useState<string[]>(() => listUserKeys());
  const [userKeyAdd, setUserKeyAdd] = useState<{ name: string; value: string }>({
    name: "",
    value: "",
  });
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    setUserKeyNames(listUserKeys());
  }, []);
  const saveUserKey = async () => {
    const n = userKeyAdd.name.trim().replace(/[^\w-]/g, "_");
    const v = userKeyAdd.value.trim();
    if (!n || !v) return;
    await setUserKey(n, v);
    setUserKeyNames(listUserKeys());
    setUserKeyAdd({ name: "", value: "" });
    setAdding(false);
  };
  const removeUserKey = async (n: string) => {
    await deleteUserKey(n);
    setUserKeyNames(listUserKeys());
  };

  const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "not set");

  const openMetaVault = async () => {
    try {
      const meta = await getMetaVaultPath();
      if (meta === vaultPath) {
        setShowSettings(false);
        return;
      }
      if (useStore.getState().busy) {
        stopAgent();
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
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Model
              </h3>
              <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
                Fetched live from each provider. Refresh to pick up new releases.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refreshCatalog()}
              disabled={catalogRefreshing}
            >
              {catalogRefreshing ? "Refreshing…" : `Refresh (${catalog.length})`}
            </Button>
          </div>
          <Input
            type="search"
            placeholder="Search models (name, id, or provider)…"
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
          />
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {catalog.length === 0 ? (
              <option value="" disabled>
                Add an API key below to load models
              </option>
            ) : filteredCatalog.length === 0 ? (
              <option value={modelId} disabled>
                No models match "{modelSearch}"
              </option>
            ) : (
              filteredCatalog.map((m) => (
                <option key={`${m.provider}:${m.id}`} value={m.id}>
                  [{PROVIDER_LABEL[m.provider]}] {m.label}
                </option>
              ))
            )}
          </Select>
          {modelSearch && (
            <p className="text-[11px] text-muted-foreground/80">
              {filteredCatalog.length} of {catalog.length} match
            </p>
          )}
          {Object.entries(catalogErrors).length > 0 && (
            <p className="text-[11px] text-amber-500/90">
              {Object.entries(catalogErrors)
                .map(([p, msg]) => `${p}: ${msg}`)
                .join(" · ")}
            </p>
          )}
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

        <section className="space-y-3">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3 w-3" />
              Security
            </h3>
            <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
              Limit what the agent can touch.
            </p>
          </div>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              className="vc-checkbox mt-0.5"
              checked={strictVaultMode}
              onChange={(e) => setStrictVaultMode(e.target.checked)}
            />
            <div className="flex-1">
              <div className="text-[12px]">Strict vault mode</div>
              <p className="text-[11px] text-muted-foreground/80">
                File-op tools (Read/Write/Edit/Delete/Glob/Grep/ListDir/NotebookEdit/PdfExtract) refuse paths outside the active vault and meta vault. Does not constrain Bash. Symlinks are not resolved.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              className="vc-checkbox mt-0.5"
              checked={bashDisabled}
              onChange={(e) => setBashDisabled(e.target.checked)}
            />
            <div className="flex-1">
              <div className="text-[12px]">Disable Bash tool</div>
              <p className="text-[11px] text-muted-foreground/80">
                Removes the shell tool from the agent. Auto-enabled when strict vault mode turns on (Bash bypasses the file guard otherwise).
              </p>
            </div>
          </label>
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
              {apiKeys[p] && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(p)}
                  title="Remove this key from the OS keychain"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
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
            {serviceKeys.tavily && (
              <Button
                size="sm"
                variant="ghost"
                onClick={removeTavily}
                title="Remove this key from the OS keychain"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Enables WebSearch. Get a free key at tavily.com.
          </p>
        </section>

        <div className="h-px bg-border" />

        <TelegramSection />

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Key className="h-3 w-3" />
                ElevenLabs (voice mode)
              </h3>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5 font-mono">
                {mask(serviceKeys.elevenlabs)}
              </p>
            </div>
            {savedFlash === "elevenlabs" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> saved
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="sk_…"
              value={elevenlabsDraft}
              onChange={(e) => setElevenlabsDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveElevenlabs();
              }}
            />
            <Button size="sm" onClick={saveElevenlabs} disabled={!elevenlabsDraft.trim()}>
              Save
            </Button>
            {serviceKeys.elevenlabs && (
              <Button
                size="sm"
                variant="ghost"
                onClick={removeElevenlabs}
                title="Remove this key from the OS keychain"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Required for voice mode. Conversational AI plan needed (free tier
            includes 15 min/mo). Get a key at elevenlabs.io.
          </p>
          <div className="flex items-center justify-between pt-2">
            <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Voice ID
            </h4>
            {savedFlash === "elevenlabs_voice" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> saved
              </span>
            )}
          </div>
          <details ref={voicePickerRef} className="w-full rounded border border-border bg-background group">
            <summary className="h-8 px-2 flex items-center justify-between cursor-pointer text-[12px] font-mono list-none">
              <span className="truncate">
                {voiceLibrary.find((v) => v.id === elevenlabsVoiceDraft)?.name ?? "(unsaved)"}
                <span className="ml-2 text-muted-foreground/60">{elevenlabsVoiceDraft}</span>
              </span>
              <span className="text-muted-foreground/60 group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="border-t border-border max-h-48 overflow-y-auto">
              {voiceLibrary.length === 0 && (
                <div className="px-2 py-2 text-[11px] text-muted-foreground/70">
                  No saved voices yet. Add one below.
                </div>
              )}
              {voiceLibrary.map((v) => {
                const active = v.id === elevenlabsVoiceDraft;
                return (
                  <div
                    key={v.id}
                    className={`flex items-center justify-between px-2 py-1.5 text-[12px] cursor-pointer hover:bg-muted/40 ${active ? "bg-muted/60" : ""}`}
                    onClick={() => saveElevenlabsVoice(v.id)}
                  >
                    <span className="truncate flex-1">
                      <span className="font-medium text-foreground/90">{v.name}</span>
                      <span className="ml-2 font-mono text-muted-foreground/60">{v.id}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeVoiceFromLibrary(v.id);
                      }}
                      title="Remove from library"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </details>
          <div className="flex gap-2 pt-1">
            <Input
              type="text"
              placeholder="Name (e.g. Rachel)"
              value={newVoiceName}
              onChange={(e) => setNewVoiceName(e.target.value)}
              className="flex-[2]"
            />
            <Input
              type="text"
              placeholder="Voice ID"
              value={newVoiceId}
              onChange={(e) => setNewVoiceId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addVoiceToLibrary();
              }}
              className="flex-[3] font-mono"
            />
            <Button size="sm" onClick={addVoiceToLibrary} disabled={!newVoiceName.trim() || !newVoiceId.trim()}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/80">
            Browse voices at elevenlabs.io/app/voice-library, then add them here
            with a memorable name. Selecting from the dropdown sets the active voice.
          </p>
          <div className="flex items-center justify-between pt-2">
            <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Voice model
            </h4>
            {savedFlash === "elevenlabs_llm" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> saved
              </span>
            )}
          </div>
          <select
            value={elevenlabsLlmDraft}
            onChange={(e) => saveElevenlabsLlm(e.target.value)}
            className="w-full h-8 px-2 rounded border border-border bg-background text-[12px] font-mono"
          >
            <optgroup label="Gemini (default — native PDF vision)">
              <option value="gemini-2.5-flash">gemini-2.5-flash (default)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro (deeper reasoning)</option>
            </optgroup>
            <optgroup label="Claude — Sonnet">
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 (newest)</option>
              <option value="claude-sonnet-4-5@20250929">claude-sonnet-4-5</option>
              <option value="claude-sonnet-4@20250514">claude-sonnet-4</option>
              <option value="claude-3-7-sonnet">claude-3-7-sonnet</option>
            </optgroup>
            <optgroup label="Claude — Opus (smartest, slower)">
              <option value="claude-opus-4-7">claude-opus-4-7</option>
            </optgroup>
            <optgroup label="Claude — Haiku (fastest)">
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
            </optgroup>
          </select>
          <p className="text-[11px] text-muted-foreground/80">
            Brain that handles voice turns. Gemini 2.5 Flash is the default —
            it sees PDFs natively (every page, diagram, equation) with the
            snappiest TTFT. Switch to gemini-2.5-pro for deep math. Claude
            variants don't get the PDF blob piped in, so they fall back to
            the PdfExtract tool. Changes re-provision the agent on next
            session.
          </p>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Lock className="h-3 w-3" />
                Your keys
              </h3>
              <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                Custom credentials your vault-tools can request via{" "}
                <code className="font-mono bg-muted px-1 rounded text-[10.5px]">
                  requires_keys
                </code>{" "}
                in TOOL.md. Stored in the OS keychain, passed to scripts as
                environment variables at run-time. The agent never sees the
                values.
              </p>
            </div>
            {!adding && (
              <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                <Plus className="h-3 w-3" />
              </Button>
            )}
          </div>
          {adding && (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-2">
              <Input
                placeholder="name (e.g. gmail_token)"
                value={userKeyAdd.name}
                onChange={(e) =>
                  setUserKeyAdd((s) => ({ ...s, name: e.target.value }))
                }
                autoFocus
              />
              <Input
                type="password"
                placeholder="value"
                value={userKeyAdd.value}
                onChange={(e) =>
                  setUserKeyAdd((s) => ({ ...s, value: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveUserKey();
                }}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={saveUserKey}
                  disabled={!userKeyAdd.name.trim() || !userKeyAdd.value.trim()}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                    setUserKeyAdd({ name: "", value: "" });
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {userKeyNames.length > 0 && (
            <ul className="divide-y divide-border/40 rounded-md border border-border/60">
              {userKeyNames.map((n) => (
                <li
                  key={n}
                  className="flex items-center justify-between px-3 py-1.5 text-[12.5px]"
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-foreground/90">{n}</span>
                    <span className="text-[10.5px] text-muted-foreground">
                      ••••••••
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeUserKey(n)}
                    title="Remove"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {userKeyNames.length === 0 && !adding && (
            <p className="text-[11px] text-muted-foreground/60 italic">
              No custom keys yet.
            </p>
          )}
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

        <CrossSyncSection />

        <div className="h-px bg-border" />

        <VaultSyncSection />

        <div className="h-px bg-border" />

        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Storage
          </h3>
          <p className="text-[11.5px] text-muted-foreground leading-relaxed">
            API keys are stored in the OS keychain (Windows Credential Manager
            / Mac Keychain / Linux libsecret) under the service name{" "}
            <code className="font-mono bg-muted px-1 rounded text-[10.5px]">
              com.vault-chat.app
            </code>
            . The agent's file-op tools cannot reach them. Model preference and
            theme live in <code className="font-mono bg-muted px-1 rounded text-[10.5px]">localStorage</code>.
          </p>
        </section>
      </div>
    </div>
  );
}

function VaultSyncSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [config, setConfig] = useState<VaultSyncConfig | null>(null);
  const [remoteDraft, setRemoteDraft] = useState("");
  const [snapshot, setSnapshot] = useState({
    lastSyncedAt: null as number | null,
    lastMessage: "",
    lastError: null as string | null,
    running: false,
    remote: null as string | null,
    hasChanges: false,
    nestedRepos: [] as string[],
  });
  const [busy, setBusy] = useState(false);
  const [repoNameDraft, setRepoNameDraft] = useState("");
  const [creatingRepo, setCreatingRepo] = useState(false);

  useEffect(() => {
    if (!vaultPath) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    void readVaultSyncConfig(vaultPath).then((c) => {
      if (cancelled) return;
      setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  useEffect(() => {
    const unsub = subscribeSyncStatus((snap) => {
      setSnapshot(snap);
      if (snap.remote && remoteDraft === "") {
        setRemoteDraft(snap.remote);
      }
    });
    return unsub;
  }, [remoteDraft]);

  useEffect(() => {
    if (snapshot.remote && !remoteDraft) {
      setRemoteDraft(snapshot.remote);
    }
  }, [snapshot.remote, remoteDraft]);

  if (!vaultPath || !config) {
    return (
      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" />
          Vault sync (this vault)
        </h3>
        <p className="text-[11.5px] text-muted-foreground/80">
          Open a vault to configure auto-sync.
        </p>
      </section>
    );
  }

  const toggleEnabled = async (next: boolean) => {
    const updated = await writeVaultSyncConfig(vaultPath, { enabled: next });
    setConfig(updated);
    if (next) {
      await startVaultSyncLoop(vaultPath);
    } else {
      stopVaultSyncLoop();
    }
  };

  const saveRemote = async () => {
    setBusy(true);
    try {
      await setVaultRemote(vaultPath, remoteDraft.trim());
      if (config.enabled) await startVaultSyncLoop(vaultPath);
    } catch (e) {
      console.warn("[vault-sync] set remote failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const saveIntervals = async (patch: Partial<VaultSyncConfig>) => {
    const next = await writeVaultSyncConfig(vaultPath, patch);
    setConfig(next);
    if (next.enabled) await startVaultSyncLoop(vaultPath);
  };

  const forcePull = async () => {
    setBusy(true);
    try {
      await vaultPull(vaultPath);
    } finally {
      setBusy(false);
    }
  };

  const forcePush = async () => {
    setBusy(true);
    try {
      await vaultCommitLocal(vaultPath);
      await vaultPush(vaultPath);
    } finally {
      setBusy(false);
    }
  };

  const createGhRepo = async () => {
    const name = repoNameDraft.trim();
    if (!name) return;
    setBusy(true);
    try {
      const result = await vaultGhCreateRepo(vaultPath, name, true);
      if (result.ok) {
        setRepoNameDraft("");
        setCreatingRepo(false);
        if (config.enabled) await startVaultSyncLoop(vaultPath);
      } else {
        console.warn("[vault-sync] gh repo create:", result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3" />
            Vault sync (this vault)
          </h3>
          <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
            Continuous auto-commit + push + pull against the vault's git remote.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <span className="text-[10.5px] text-muted-foreground">
            {config.enabled ? "on" : "off"}
          </span>
          <input
            type="checkbox"
            className="vc-checkbox"
            checked={config.enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
        </label>
      </div>
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
            Git remote
          </label>
          <div className="flex gap-2">
            <Input
              type="text"
              value={remoteDraft}
              onChange={(e) => setRemoteDraft(e.target.value)}
              placeholder="git@github.com:user/repo.git"
              className="font-mono text-[11.5px]"
            />
            <Button size="sm" onClick={saveRemote} disabled={busy}>
              Save
            </Button>
          </div>
          {!snapshot.remote && !creatingRepo && (
            <button
              onClick={() => setCreatingRepo(true)}
              className="text-[10.5px] text-muted-foreground/80 hover:text-foreground underline"
            >
              Create on GitHub (gh repo create)
            </button>
          )}
          {creatingRepo && (
            <div className="flex gap-2 pt-1">
              <Input
                type="text"
                value={repoNameDraft}
                onChange={(e) => setRepoNameDraft(e.target.value)}
                placeholder="repo name (e.g. school)"
                className="font-mono text-[11.5px]"
              />
              <Button size="sm" onClick={createGhRepo} disabled={busy || !repoNameDraft.trim()}>
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreatingRepo(false);
                  setRepoNameDraft("");
                }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
              Pull every
            </label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={5}
                value={config.pullIntervalSec}
                onChange={(e) =>
                  saveIntervals({
                    pullIntervalSec: Math.max(5, Number(e.target.value) || DEFAULT_SYNC_CONFIG.pullIntervalSec),
                  })
                }
                className="flex-1 tabular-nums"
              />
              <span className="text-[10.5px] text-muted-foreground">seconds</span>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
              Push after
            </label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                value={config.pushDebounceSec}
                onChange={(e) =>
                  saveIntervals({
                    pushDebounceSec: Math.max(1, Number(e.target.value) || DEFAULT_SYNC_CONFIG.pushDebounceSec),
                  })
                }
                className="flex-1 tabular-nums"
              />
              <span className="text-[10.5px] text-muted-foreground">seconds quiet</span>
            </div>
          </div>
        </div>
        {snapshot.nestedRepos.length > 0 && (
          <div className="text-[10.5px] text-muted-foreground/80 pt-1">
            Nested git repos in this vault sync independently against their own remotes:{" "}
            {snapshot.nestedRepos.map((n, i) => (
              <span key={n}>
                {i > 0 && ", "}
                <span className="font-mono text-foreground/85">{n}</span>
              </span>
            ))}{" "}
            (skipped)
          </div>
        )}
        <div className="pt-1 flex items-center gap-2 flex-wrap">
          <SyncStatusRow snapshot={snapshot} enabled={config.enabled} />
          <span className="text-[10.5px] text-muted-foreground/70">·</span>
          <button
            onClick={forcePull}
            disabled={busy || !snapshot.remote}
            className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
          >
            force pull
          </button>
          <button
            onClick={forcePush}
            disabled={busy || !snapshot.remote}
            className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
          >
            force push
          </button>
        </div>
      </div>
    </section>
  );
}

function SyncStatusRow({
  snapshot,
  enabled,
}: {
  snapshot: {
    lastSyncedAt: number | null;
    lastMessage: string;
    lastError: string | null;
    running: boolean;
    remote: string | null;
    hasChanges: boolean;
  };
  enabled: boolean;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        idle
      </span>
    );
  }
  if (snapshot.lastError) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        {snapshot.lastError}
      </span>
    );
  }
  if (snapshot.running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        syncing…
      </span>
    );
  }
  const label = snapshot.lastSyncedAt
    ? `synced · ${relativeAgo(snapshot.lastSyncedAt)} ago`
    : snapshot.remote
      ? "waiting"
      : "no remote";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      {label}
    </span>
  );
}

function relativeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function CrossSyncSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [config, setConfig] = useState<CrossSyncConfig>(() => readCrossSyncConfig());
  const [snapshot, setSnapshot] = useState<CrossSyncSnapshot>({
    mode: config.mode,
    running: false,
    clients: 0,
    listen: null,
    error: null,
    tailscaleHostname: null,
  });
  const [tailscaleProbed, setTailscaleProbed] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeCrossSyncStatus(setSnapshot);
    return unsub;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void probeTailscaleHostname().then((h) => {
      if (cancelled) return;
      setTailscaleProbed(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = async (patch: Partial<CrossSyncConfig>) => {
    const next = writeCrossSyncConfig(patch);
    setConfig(next);
    if (vaultPath) {
      await stopCrossSync();
      await startCrossSync(vaultPath);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Monitor className="h-3 w-3" />
          Cross-machine sync
        </h3>
        <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
          Run vault-chat as a daemon at home; connect to it from another machine over Tailscale.
        </p>
      </div>
      <div className="space-y-2">
        <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
          This machine is
        </label>
        <div className="space-y-1">
          <ModeRow
            label="Standalone"
            sublabel="no sync (default)"
            active={config.mode === "standalone"}
            onSelect={() => update({ mode: "standalone" })}
          />
          <ModeRow
            label="Daemon (the home box)"
            sublabel="listens for clients"
            active={config.mode === "daemon"}
            onSelect={() => update({ mode: "daemon" })}
          />
          <ModeRow
            label="Client (this is the portable)"
            sublabel="connects to a daemon"
            active={config.mode === "client"}
            onSelect={() => update({ mode: "client" })}
          />
        </div>
        {config.mode === "daemon" && (
          <div className="pt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
                Listen on
              </label>
              <Input
                type="text"
                value={config.daemonListen}
                onChange={(e) => update({ daemonListen: e.target.value })}
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
                Tailscale hostname
              </label>
              <Input
                type="text"
                value={config.tailscaleHostname || tailscaleProbed || ""}
                onChange={(e) => update({ tailscaleHostname: e.target.value })}
                placeholder={tailscaleProbed ?? "home-box.tail-scale.ts.net"}
                className="font-mono"
              />
            </div>
          </div>
        )}
        {config.mode === "client" && (
          <div className="pt-2 space-y-1">
            <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
              Daemon URL
            </label>
            <Input
              type="text"
              value={config.daemonUrl}
              onChange={(e) => update({ daemonUrl: e.target.value })}
              placeholder="http://home-box.tail-scale.ts.net:4173"
              className="font-mono"
            />
          </div>
        )}
        {!tailscaleProbed && config.mode !== "standalone" && (
          <p className="text-[10.5px] text-muted-foreground/80">
            Tailscale not detected.{" "}
            <a
              href="https://tailscale.com/download"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              Install Tailscale
            </a>{" "}
            to expose this machine over a private mesh.
          </p>
        )}
        <CrossSyncStatusRow snapshot={snapshot} config={config} />
      </div>
    </section>
  );
}

function ModeRow({
  label,
  sublabel,
  active,
  onSelect,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={
        active
          ? "flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-primary/60 bg-primary/10 cursor-pointer"
          : "flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border hover:bg-accent/40 cursor-pointer"
      }
    >
      <input
        type="radio"
        name="cross-sync-mode"
        className="vc-radio"
        checked={active}
        onChange={onSelect}
      />
      <span className="text-[12px] text-foreground">{label}</span>
      <span className="ml-auto text-[10.5px] text-muted-foreground">{sublabel}</span>
    </label>
  );
}

function CrossSyncStatusRow({
  snapshot,
  config,
}: {
  snapshot: CrossSyncSnapshot;
  config: CrossSyncConfig;
}) {
  if (config.mode === "standalone") {
    return null;
  }
  if (snapshot.error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive pt-1">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        {snapshot.error}
      </span>
    );
  }
  if (config.mode === "daemon" && snapshot.running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        daemon running on {snapshot.listen ?? config.daemonListen}
      </span>
    );
  }
  if (config.mode === "client") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" />
        client · {config.daemonUrl || "no URL"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      idle
    </span>
  );
}


function TelegramSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [enabled, setEnabled] = useState(() => readTelegramEnabled(vaultPath));
  const [tokenDraft, setTokenDraft] = useState("");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [snapshot, setSnapshot] = useState<TelegramSnapshot>({
    running: false,
    botUsername: null,
    error: null,
    hasCredentials: false,
  });
  const [testStatus, setTestStatus] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; message: string }
    | { kind: "err"; message: string }
  >({ kind: "idle" });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tgModelDraft, setTgModelDraft] = useState(() => getTelegramModelId());

  useEffect(() => {
    let cancelled = false;
    setTokenDraft("");
    setUserIdDraft("");
    setEnabled(readTelegramEnabled(vaultPath));
    void (async () => {
      const { token, userId } = await getTelegramCredentials(vaultPath);
      if (cancelled) return;
      if (token) setTokenDraft(token);
      if (userId) setUserIdDraft(userId);
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  useEffect(() => {
    const unsub = subscribeTelegramStatus(vaultPath, setSnapshot);
    void refreshTelegramSnapshot(vaultPath);
    return unsub;
  }, [vaultPath]);

  const toggleEnabled = async (next: boolean) => {
    if (!vaultPath) return;
    setEnabled(next);
    writeTelegramEnabled(vaultPath, next);
    if (next) {
      const tok = tokenDraft.trim();
      const uid = userIdDraft.trim();
      if (tok && uid) {
        await setTelegramCredentials(vaultPath, tok, uid);
      }
      await startTelegramService(vaultPath);
    } else {
      await stopTelegramService(vaultPath);
    }
  };

  const saveCredentials = async () => {
    if (!vaultPath) return;
    const tok = tokenDraft.trim();
    const uid = userIdDraft.trim();
    if (!tok || !uid) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      await setTelegramCredentials(vaultPath, tok, uid);
      if (enabled) {
        await stopTelegramService(vaultPath);
        await startTelegramService(vaultPath);
      }
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1800);
    } catch (e) {
      setSaveState("error");
      setSaveError(String(e));
    }
  };

  const removeCredentials = async () => {
    if (!vaultPath) return;
    await stopTelegramService(vaultPath);
    await clearTelegramCredentials(vaultPath);
    setTokenDraft("");
    setUserIdDraft("");
    setEnabled(false);
    writeTelegramEnabled(vaultPath, false);
  };

  const testConnection = async () => {
    const tok = tokenDraft.trim();
    if (!tok) return;
    setTestStatus({ kind: "testing" });
    const res = await testTelegramConnection(tok);
    if (res.ok) {
      setTestStatus({ kind: "ok", message: res.message });
    } else {
      setTestStatus({ kind: "err", message: res.message });
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Send className="h-3 w-3" />
            Telegram bot
            {vaultPath && (
              <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/70">
                · {vaultPath.split(/[/\\]/).filter(Boolean).pop()}
              </span>
            )}
          </h3>
          <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">
            Per-vault: each vault gets its own bot (one token here = one bot
            on Telegram). User ID is shared across all vaults.
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <span className="text-[10.5px] text-muted-foreground">
            {enabled ? "on" : "off"}
          </span>
          <input
            type="checkbox"
            className="vc-checkbox"
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
        </label>
      </div>
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
            Bot token
          </label>
          <Input
            type="password"
            placeholder="123456:ABC-…"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            className="font-mono text-[11.5px]"
          />
          <p className="text-[10.5px] text-muted-foreground/70">
            From @BotFather on Telegram.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
            Your Telegram user ID
          </label>
          <Input
            type="text"
            placeholder="743210984"
            value={userIdDraft}
            onChange={(e) => setUserIdDraft(e.target.value)}
            className="font-mono text-[11.5px]"
          />
          <p className="text-[10.5px] text-muted-foreground/70">
            From @userinfobot. Locks the bot to only your messages.
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
            Telegram brain
          </label>
          <select
            value={tgModelDraft}
            onChange={(e) => {
              setTgModelDraft(e.target.value);
              setTelegramModelId(e.target.value);
            }}
            className="w-full h-8 px-2 rounded border border-border bg-background text-[12px] font-mono"
          >
            <optgroup label="Haiku (cheap, recommended)">
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
            </optgroup>
            <optgroup label="Sonnet (heavier reasoning)">
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
              <option value="claude-sonnet-4-5@20250929">claude-sonnet-4-5</option>
            </optgroup>
            <optgroup label="Opus (full muscle, slow + pricey)">
              <option value="claude-opus-4-7">claude-opus-4-7</option>
            </optgroup>
            <optgroup label="Gemini">
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            </optgroup>
          </select>
          <p className="text-[10.5px] text-muted-foreground/70">
            Model the agent uses when replying to a Telegram-sourced chat
            (inbound messages or scheduled fires). Defaults to Haiku since
            the phone path is usually quick replies + light tool use;
            keeps cost down on daily / hourly schedules. Override if you
            actually want the bot doing heavy work over Telegram.
          </p>
        </div>
        <div className="pt-1 flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={testConnection}
            disabled={!tokenDraft.trim() || testStatus.kind === "testing"}
          >
            {testStatus.kind === "testing" ? "Testing…" : "Test connection"}
          </Button>
          <Button
            size="sm"
            onClick={saveCredentials}
            disabled={!tokenDraft.trim() || !userIdDraft.trim() || saveState === "saving"}
          >
            {saveState === "saving" ? "Saving…" : "Save"}
          </Button>
          {saveState === "saved" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
              <Check className="h-3 w-3" /> saved to keychain
            </span>
          )}
          {saveState === "error" && saveError && (
            <span className="text-[11px] text-destructive">save failed: {saveError}</span>
          )}
          {(tokenDraft || userIdDraft) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={removeCredentials}
              title="Remove credentials from the OS keychain"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
          <TelegramStatusRow snapshot={snapshot} testStatus={testStatus} enabled={enabled} />
        </div>
      </div>
    </section>
  );
}

function TelegramStatusRow({
  snapshot,
  testStatus,
  enabled,
}: {
  snapshot: TelegramSnapshot;
  testStatus:
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; message: string }
    | { kind: "err"; message: string };
  enabled: boolean;
}) {
  if (testStatus.kind === "ok") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        connected as {testStatus.message}
      </span>
    );
  }
  if (testStatus.kind === "err") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        {testStatus.message}
      </span>
    );
  }
  if (snapshot.error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-destructive">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        {snapshot.error}
      </span>
    );
  }
  if (enabled && snapshot.running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {snapshot.botUsername ? `connected as ${snapshot.botUsername}` : "polling"}
      </span>
    );
  }
  if (!snapshot.hasCredentials) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        no credentials
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      idle
    </span>
  );
}
