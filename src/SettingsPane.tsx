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
  Megaphone,
  Send,
  Shield,
} from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { PROVIDER_LABEL, type ProviderId } from "./providers";
import { Button, Input, Select } from "./ui";
import { getMetaVaultPath } from "./meta";
import { gitInitIfNeeded } from "./git";
import { stopAgent } from "./chat-controller";
import { listUserKeys, setUserKey, deleteUserKey } from "./keychain";
import { testGithubToken } from "./feedback";

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
  const [githubDraft, setGithubDraft] = useState(serviceKeys.github_pat ?? "");
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
    localStorage.getItem("vault_chat_elevenlabs_llm") ?? "claude-sonnet-4-6",
  );
  const [githubTestState, setGithubTestState] = useState<
    | { phase: "idle" }
    | { phase: "testing" }
    | { phase: "ok"; login: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const [savedFlash, setSavedFlash] = useState<
    | ProviderId
    | "tavily"
    | "github_pat"
    | "elevenlabs"
    | "elevenlabs_voice"
    | "elevenlabs_llm"
    | null
  >(null);
  const openFeedbackComposer = useStore((s) => s.openFeedbackComposer);

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

  const saveGithubPat = () => {
    const v = githubDraft.trim();
    if (!v) return;
    setServiceKey("github_pat", v);
    setGithubDraft(v);
    setSavedFlash("github_pat");
    setTimeout(() => setSavedFlash((x) => (x === "github_pat" ? null : x)), 1500);
    setGithubTestState({ phase: "idle" });
  };

  const removeGithubPat = () => {
    clearServiceKey("github_pat");
    setGithubDraft("");
    setGithubTestState({ phase: "idle" });
  };

  const testGithubPat = async () => {
    const v = (githubDraft.trim() || serviceKeys.github_pat || "").trim();
    if (!v) {
      setGithubTestState({ phase: "error", message: "Enter or save a token first." });
      return;
    }
    setGithubTestState({ phase: "testing" });
    try {
      const login = await testGithubToken(v);
      setGithubTestState({ phase: "ok", login });
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setGithubTestState({ phase: "error", message: msg });
    }
  };

  const sendFeedbackFromSettings = () => {
    setShowSettings(false);
    openFeedbackComposer();
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
            <optgroup label="Sonnet (recommended for voice)">
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 (newest)</option>
              <option value="claude-sonnet-4-5@20250929">claude-sonnet-4-5</option>
              <option value="claude-sonnet-4@20250514">claude-sonnet-4</option>
              <option value="claude-3-7-sonnet">claude-3-7-sonnet</option>
            </optgroup>
            <optgroup label="Opus (smartest, slower)">
              <option value="claude-opus-4-7">claude-opus-4-7</option>
            </optgroup>
            <optgroup label="Haiku (fastest, cheapest)">
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
            </optgroup>
          </select>
          <p className="text-[11px] text-muted-foreground/80">
            Brain that handles voice turns. Sonnet 4.6 is the default — Opus
            adds noticeable latency, Haiku is less reliable with tools. Changes
            re-provision the agent on next session.
          </p>
        </section>

        <div className="h-px bg-border" />

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground flex items-center gap-1.5">
                <Megaphone className="h-3 w-3" />
                Send feedback (Ctrl+G)
              </h3>
              <p className="text-[11.5px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                Files a GitHub issue on the vault-chat repo with label{" "}
                <code className="font-mono bg-muted px-1 rounded text-[10.5px]">
                  auto-fix:queued
                </code>
                . A scheduled cloud agent picks the queue up nightly, lands a
                fix on <code className="font-mono bg-muted px-1 rounded text-[10.5px]">main</code>{" "}
                with a verification comment, and re-labels{" "}
                <code className="font-mono bg-muted px-1 rounded text-[10.5px]">
                  awaiting-verification
                </code>
                . Needs a GitHub PAT with the{" "}
                <code className="font-mono bg-muted px-1 rounded text-[10.5px]">repo</code>{" "}
                scope.
              </p>
            </div>
            {savedFlash === "github_pat" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> saved
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={serviceKeys.github_pat ? "ghp_… (replace existing)" : "ghp_…"}
              value={githubDraft}
              onChange={(e) => setGithubDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveGithubPat();
              }}
            />
            <Button size="sm" onClick={saveGithubPat} disabled={!githubDraft.trim()}>
              Save
            </Button>
            {serviceKeys.github_pat && (
              <Button
                size="sm"
                variant="ghost"
                onClick={removeGithubPat}
                title="Remove this token from the OS keychain"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/70 font-mono">
            {serviceKeys.github_pat
              ? `${serviceKeys.github_pat.slice(0, 8)}…${serviceKeys.github_pat.slice(-4)}`
              : "not set"}
          </p>
          <div className="flex gap-2 items-center flex-wrap">
            <Button size="sm" variant="outline" onClick={testGithubPat}>
              Test connection
            </Button>
            <Button
              size="sm"
              onClick={sendFeedbackFromSettings}
              disabled={!serviceKeys.github_pat}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Send className="h-3 w-3 mr-1.5" />
              Send feedback now
            </Button>
            {githubTestState.phase === "testing" && (
              <span className="text-[11px] text-muted-foreground">testing…</span>
            )}
            {githubTestState.phase === "ok" && (
              <span className="text-[11px] text-emerald-500 flex items-center gap-1">
                <Check className="h-3 w-3" /> authenticated as{" "}
                <span className="font-mono">{githubTestState.login}</span>
              </span>
            )}
            {githubTestState.phase === "error" && (
              <span className="text-[11px] text-destructive">
                {githubTestState.message}
              </span>
            )}
          </div>
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
