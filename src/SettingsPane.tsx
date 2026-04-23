import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Check, Key, Cog, X, Plus, Lock } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { PROVIDER_LABEL, type ProviderId } from "./providers";
import { Button, Input, Select } from "./ui";
import { getMetaVaultPath } from "./meta";
import { gitInitIfNeeded } from "./git";
import { listUserKeys, setUserKey, deleteUserKey } from "./keychain";

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
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    anthropic: apiKeys.anthropic ?? "",
    openai: apiKeys.openai ?? "",
    google: apiKeys.google ?? "",
    openrouter: apiKeys.openrouter ?? "",
  });
  const [tavilyDraft, setTavilyDraft] = useState(serviceKeys.tavily ?? "");
  const [savedFlash, setSavedFlash] = useState<ProviderId | "tavily" | null>(null);

  const save = (p: ProviderId) => {
    const v = drafts[p].trim();
    if (v) {
      setApiKey(p, v);
      setDrafts((d) => ({ ...d, [p]: "" }));
      setSavedFlash(p);
      setTimeout(() => setSavedFlash((x) => (x === p ? null : x)), 1500);
    }
  };

  const remove = (p: ProviderId) => {
    clearApiKey(p);
    setDrafts((d) => ({ ...d, [p]: "" }));
  };

  const saveTavily = () => {
    const v = tavilyDraft.trim();
    if (v) {
      setServiceKey("tavily", v);
      setTavilyDraft("");
      setSavedFlash("tavily");
      setTimeout(() => setSavedFlash((x) => (x === "tavily" ? null : x)), 1500);
    }
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
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {catalog.map((m) => (
              <option key={`${m.provider}:${m.id}`} value={m.id}>
                [{PROVIDER_LABEL[m.provider]}] {m.label}
              </option>
            ))}
          </Select>
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
