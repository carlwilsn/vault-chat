import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, X, Plus, ChevronDown } from "lucide-react";
import { useStore } from "./store";
import { PROVIDER_LABEL, AUTO_MODEL_ID, type ModelSpec, type ProviderId } from "./providers";
import { Button, Input, MenuSelect, type MenuGroup } from "./ui";
import { SUPPORTED_VOICE_LLMS, DEFAULT_LLM } from "./voice-elevenlabs";
import {
  readVoiceLibraryCache,
  readVoiceLibrary,
  writeVoiceLibrary,
  DEFAULT_VOICES,
  type SavedVoice,
} from "./voiceLibrary";
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
  type VaultSyncConfig,
  readBoxConfig,
  subscribeBoxSync,
  boxSyncNow,
  fmtSize,
  type BoxConfig,
  type BoxSyncState,
} from "./vaultSync";
import { ROLE_LABEL, type RoleId } from "./roles";
import { CAP_KEYS, loadModelCaps, type CapKey, type ModelCaps } from "./modelCaps";

// Six sections: Models, Keys, Voice, Box, Safety, Appearance.

const KEY_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
  openrouter: "sk-or-…",
};

const mask = (k?: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "not set");

function SectionHead({ title, hint, right }: { title: string; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {hint && <p className="text-[11.5px] text-muted-foreground/80 mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

const Divider = () => <div className="h-px bg-border" />;

export function SettingsPane() {
  const setShowSettings = useStore((s) => s.setShowSettings);
  return (
    <div className="h-full flex flex-col bg-card border-l border-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => setShowSettings(false)}>
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-[13px] font-semibold">Settings</span>
      </div>
      <div className="flex-1 overflow-auto p-5 space-y-6">
        <ModelsSection />
        <Divider />
        <KeysSection />
        <Divider />
        <VoiceSection />
        <Divider />
        <BoxSection />
        <Divider />
        <SafetySection />
        <Divider />
        <AppearanceSection />
      </div>
    </div>
  );
}

// ---- Models ------------------------------------------------------------------

const shortName = (label: string) => label.replace(/^[^:]+:\s*/, "");

const VOICE_GROUPS: MenuGroup[] = [
  {
    label: "Gemini (default — native PDF vision)",
    options: [
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash (default)" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash (older)" },
    ],
  },
  {
    label: "Claude — Sonnet",
    options: [
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6 (newest)" },
      { value: "claude-sonnet-4-5@20250929", label: "claude-sonnet-4-5" },
      { value: "claude-sonnet-4@20250514", label: "claude-sonnet-4" },
      { value: "claude-3-7-sonnet", label: "claude-3-7-sonnet" },
    ],
  },
  {
    label: "Claude — Haiku (fastest)",
    options: [{ value: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5" }],
  },
];

/** Which capability layout to draw. A preview switch while Carl picks one;
 *  the losing layouts go once he has. */
type CapsView = "table" | "inline" | "fold";
function capsView(): CapsView {
  try {
    const v = localStorage.getItem("vault_chat_caps_view");
    return v === "inline" || v === "fold" ? v : "table";
  } catch {
    return "table";
  }
}

function ModelsSection() {
  const catalog = useStore((s) => s.catalog);
  const catalogRefreshing = useStore((s) => s.catalogRefreshing);
  const catalogErrors = useStore((s) => s.catalogErrors);
  const refreshCatalog = useStore((s) => s.refreshCatalog);
  const hasOpenRouter = useStore((s) => !!s.apiKeys.openrouter);
  const modelId = useStore((s) => s.modelId);
  const setModelId = useStore((s) => s.setModelId);
  const setAssistantModelId = useStore((s) => s.setAssistantModelId);
  const backgroundModelId = useStore((s) => s.backgroundModelId);
  const setBackgroundModelId = useStore((s) => s.setBackgroundModelId);
  const autoRouterCostBias = useStore((s) => s.autoRouterCostBias);
  const setAutoRouterCostBias = useStore((s) => s.setAutoRouterCostBias);
  const reasoningEffort = useStore((s) => s.reasoningEffort);
  const setReasoningEffort = useStore((s) => s.setReasoningEffort);

  const [voiceLlm, setVoiceLlm] = useState(() => {
    // A stored model ElevenLabs no longer runs falls back to the default, so
    // the picker never renders blank.
    const stored = localStorage.getItem("vault_chat_elevenlabs_llm");
    return stored && SUPPORTED_VOICE_LLMS.has(stored) ? stored : DEFAULT_LLM;
  });
  const saveVoiceLlm = (v: string) => {
    localStorage.setItem("vault_chat_elevenlabs_llm", v);
    setVoiceLlm(v);
  };

  const [search, setSearch] = useState("");
  const filtered = (() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return catalog;
    return catalog.filter((m) => {
      const hay = `${m.provider} ${m.id} ${m.label}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  })();
  const labelOf = (id: string) => {
    if (id === AUTO_MODEL_ID) return "Auto — smart routing";
    const m = catalog.find((c) => c.id === id);
    return m ? `[${PROVIDER_LABEL[m.provider]}] ${m.label}` : id;
  };
  const groups = (withAuto: boolean): MenuGroup[] => [
    ...(withAuto ? [{ options: [{ value: AUTO_MODEL_ID, label: "Auto — smart routing" }] }] : []),
    ...(filtered.length
      ? [{ options: filtered.map((m: ModelSpec) => ({ value: m.id, label: `[${PROVIDER_LABEL[m.provider]}] ${m.label}` })) }]
      : []),
  ];

  // The capability view covers the models these roles run (voice runs on
  // ElevenLabs, so it has no OpenRouter row).
  const used: Array<[RoleId, string]> = (
    [
      ["chat", modelId],
      ["background", backgroundModelId],
    ] as Array<[RoleId, string]>
  ).filter(([, id]) => id !== AUTO_MODEL_ID);
  const usedKey = used.map(([, id]) => id).join("|");
  const [caps, setCaps] = useState<ModelCaps[]>([]);
  useEffect(() => {
    let alive = true;
    void loadModelCaps([...new Set(used.map(([, id]) => id))]).then((c) => alive && setCaps(c));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedKey]);
  const view = capsView();
  const capsOf = (id: string) => caps.find((c) => c.id === id);

  const rows: Array<{ role: RoleId; value: string; onChange: (v: string) => void; groups: MenuGroup[]; mono?: boolean }> = [
    {
      role: "chat",
      value: modelId,
      onChange: (v) => {
        setModelId(v);
        setAssistantModelId(v);
      },
      groups: groups(true),
    },
    { role: "background", value: backgroundModelId, onChange: setBackgroundModelId, groups: groups(false) },
    { role: "voice", value: voiceLlm, onChange: saveVoiceLlm, groups: VOICE_GROUPS, mono: true },
  ];

  return (
    <section className="space-y-2">
      <SectionHead
        title="Models"
        hint="One model per role, from the live OpenRouter list."
        right={
          <Button size="sm" variant="outline" onClick={() => refreshCatalog()} disabled={catalogRefreshing}>
            {catalogRefreshing ? "Refreshing…" : `Refresh (${catalog.length})`}
          </Button>
        }
      />
      <Input type="search" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {rows.map((r) => {
        const c = view === "inline" && r.role !== "voice" ? capsOf(r.value) : undefined;
        return (
          <div key={r.role} className="flex items-start justify-between gap-3">
            <span className="text-[12px] text-foreground/90 shrink-0 pt-1.5">{ROLE_LABEL[r.role]}</span>
            <div className="min-w-0 flex-1 max-w-[62%] space-y-1">
              <MenuSelect
                value={r.value}
                onChange={r.onChange}
                mono={r.mono}
                triggerLabel={r.role === "voice" ? undefined : labelOf(r.value)}
                emptyHint={search ? `No models match "${search}"` : undefined}
                groups={r.groups}
              />
              {c && <CapsLine caps={c} />}
            </div>
          </div>
        );
      })}
      {view !== "inline" && caps.length > 0 && (
        <CapsTable caps={caps} name={(id) => (id === AUTO_MODEL_ID ? id : shortName(labelOf(id).replace(/^\[[^\]]+\]\s*/, "")))} fold={view === "fold"} />
      )}
      {Object.entries(catalogErrors).length > 0 && (
        <p className="text-[11px] text-amber-500/90">
          {Object.entries(catalogErrors)
            .map(([p, msg]) => `${p}: ${msg}`)
            .join(" · ")}
        </p>
      )}
      {modelId === AUTO_MODEL_ID && hasOpenRouter && (
        <div className="rounded-md border border-border/60 bg-accent/20 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-foreground">Auto cost ⇄ quality</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {autoRouterCostBias <= 3 ? "Quality" : autoRouterCostBias >= 8 ? "Cheapest" : "Balanced"} ({autoRouterCostBias}/10)
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={autoRouterCostBias}
            onChange={(e) => setAutoRouterCostBias(Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-foreground/90">Reasoning effort</span>
        <select
          className="vc-select shrink-0 text-[12px] rounded-md border border-border bg-background px-2 py-1"
          value={reasoningEffort}
          onChange={(e) => setReasoningEffort(e.target.value as typeof reasoningEffort)}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
    </section>
  );
}

const CAP_LABEL: Record<CapKey, string> = { tools: "tools", images: "images", pdf: "pdf", caching: "caching", helpers: "helpers" };

function Mark({ v }: { v: boolean | undefined }) {
  if (v === true) return <Check className="h-3 w-3 text-foreground/70 inline" />;
  if (v === false) return <span className="text-muted-foreground/40">–</span>;
  return <span className="text-muted-foreground/50">?</span>;
}

/** Option A (table) and C (fold): one compact row per model in use. */
function CapsTable({ caps, name, fold }: { caps: ModelCaps[]; name: (id: string) => string; fold: boolean }) {
  const table = (
    <div className="rounded-md border border-border/60 text-[11px]">
      <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,3.25rem)_3.75rem] items-center px-2.5 py-1 text-[10px] text-muted-foreground/70 border-b border-border/40">
        <span />
        {CAP_KEYS.map((k) => (
          <span key={k} className="text-center">
            {CAP_LABEL[k]}
          </span>
        ))}
        <span className="text-right">source</span>
      </div>
      {caps.map((c) => (
        <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_repeat(5,3.25rem)_3.75rem] items-center px-2.5 py-1" title={c.id}>
          <span className="truncate text-foreground/90">{name(c.id)}</span>
          {CAP_KEYS.map((k) => (
            <span key={k} className="text-center">
              <Mark v={c.caps[k]} />
            </span>
          ))}
          <span className="text-right text-muted-foreground">{c.source}</span>
        </div>
      ))}
    </div>
  );
  if (!fold) return table;
  const untested = caps.filter((c) => c.source === "untested").length;
  return (
    <details className="group">
      <summary className="flex items-center justify-between cursor-pointer list-none text-[12px] text-foreground/90 py-0.5">
        <span>Capabilities</span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {caps.length} model{caps.length === 1 ? "" : "s"}
          {untested > 0 && ` · ${untested} untested`}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 group-open:rotate-180 transition-transform" />
        </span>
      </summary>
      <div className="pt-1.5">{table}</div>
    </details>
  );
}

/** Option B (inline): one quiet line under each role's picker. */
function CapsLine({ caps }: { caps: ModelCaps }) {
  return (
    <p className="text-[10.5px] text-muted-foreground/70 px-0.5">
      {CAP_KEYS.map((k, i) => {
        const v = caps.caps[k];
        return (
          <span key={k}>
            {i > 0 && " · "}
            <span className={v === true ? "text-foreground/75" : v === false ? "line-through text-muted-foreground/40" : "text-muted-foreground/50"}>
              {CAP_LABEL[k]}
              {v === undefined && "?"}
            </span>
          </span>
        );
      })}
      <span className="text-muted-foreground/50"> — {caps.source}</span>
    </p>
  );
}

// ---- Keys --------------------------------------------------------------------

function KeyRow({
  label,
  value,
  placeholder,
  onSave,
  onClear,
}: {
  label: string;
  value?: string;
  placeholder: string;
  onSave: (v: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [saved, setSaved] = useState(false);
  // Keys hydrate from the keychain after mount; keep the dots in step.
  useEffect(() => setDraft(value ?? ""), [value]);
  const save = () => {
    const v = draft.trim();
    if (!v) return;
    onSave(v);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="flex items-start gap-3">
      <div className="w-24 shrink-0 pt-1">
        <div className="text-[12px] text-foreground/90">{label}</div>
        {saved ? (
          <div className="text-[10.5px] text-emerald-500 flex items-center gap-1">
            <Check className="h-3 w-3" /> saved
          </div>
        ) : (
          <div className="text-[10.5px] text-muted-foreground/70 font-mono truncate">{mask(value)}</div>
        )}
      </div>
      <div className="flex-1 flex gap-2">
        <Input
          type="password"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <Button size="sm" onClick={save} disabled={!draft.trim()}>
          Save
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={onClear} title="Remove this key from the OS keychain">
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function KeysSection() {
  const apiKeys = useStore((s) => s.apiKeys);
  const serviceKeys = useStore((s) => s.serviceKeys);
  const setApiKey = useStore((s) => s.setApiKey);
  const clearApiKey = useStore((s) => s.clearApiKey);
  const setServiceKey = useStore((s) => s.setServiceKey);
  const clearServiceKey = useStore((s) => s.clearServiceKey);
  const refreshCatalog = useStore((s) => s.refreshCatalog);

  const provider = (p: ProviderId) => (
    <KeyRow
      key={p}
      label={PROVIDER_LABEL[p]}
      value={apiKeys[p]}
      placeholder={KEY_PLACEHOLDER[p]}
      onSave={(v) => {
        setApiKey(p, v);
        setTimeout(() => refreshCatalog(), 500);
      }}
      onClear={() => clearApiKey(p)}
    />
  );

  // Service keys: Tavily's fixed slot plus the named keys vault tools ask for.
  const [names, setNames] = useState<string[]>(() => listUserKeys());
  const [add, setAdd] = useState<{ name: string; value: string } | null>(null);
  const saveAdd = async () => {
    if (!add) return;
    const n = add.name.trim().replace(/[^\w-]/g, "_");
    const v = add.value.trim();
    if (!n || !v) return;
    if (n.toLowerCase() === "tavily") setServiceKey("tavily", v);
    else await setUserKey(n, v);
    setNames(listUserKeys());
    setAdd(null);
  };
  const service: Array<{ name: string; note?: string; remove: () => void }> = [
    ...(serviceKeys.tavily ? [{ name: "tavily", note: "web search", remove: () => clearServiceKey("tavily") }] : []),
    ...names.map((n) => ({
      name: n,
      remove: async () => {
        await deleteUserKey(n);
        setNames(listUserKeys());
      },
    })),
  ];

  return (
    <section className="space-y-2.5">
      <SectionHead title="Keys" hint="Kept in this machine's keychain." />
      {provider("openrouter")}
      <KeyRow
        label="ElevenLabs"
        value={serviceKeys.elevenlabs}
        placeholder="sk_…"
        onSave={(v) => setServiceKey("elevenlabs", v)}
        onClear={() => clearServiceKey("elevenlabs")}
      />
      <div className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between">
          <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">Service keys</h4>
          {!add && (
            <Button size="sm" variant="ghost" onClick={() => setAdd({ name: "", value: "" })} title="Add a key">
              <Plus className="h-3 w-3" />
            </Button>
          )}
        </div>
        {add && (
          <div className="flex gap-2">
            <Input
              placeholder="name (e.g. lambda_api_key)"
              value={add.name}
              onChange={(e) => setAdd({ ...add, name: e.target.value })}
              className="flex-[2] font-mono"
              autoFocus
            />
            <Input
              type="password"
              placeholder="value"
              value={add.value}
              onChange={(e) => setAdd({ ...add, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveAdd();
                if (e.key === "Escape") setAdd(null);
              }}
              className="flex-[3]"
            />
            <Button size="sm" onClick={() => void saveAdd()} disabled={!add.name.trim() || !add.value.trim()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdd(null)} title="Cancel">
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
        {service.length > 0 ? (
          <ul className="divide-y divide-border/40 rounded-md border border-border/60">
            {service.map((k) => (
              <li key={k.name} className="flex items-center justify-between px-3 py-1 text-[12px]">
                <span className="font-mono text-foreground/90">
                  {k.name}
                  {k.note && <span className="ml-2 font-sans text-[10.5px] text-muted-foreground">{k.note}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={k.remove} title="Remove">
                  <X className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          !add && <p className="text-[11px] text-muted-foreground/60 italic">No service keys yet.</p>
        )}
        <p className="text-[11px] text-muted-foreground/80">
          Vault tools get these as environment variables (
          <code className="font-mono bg-muted px-1 rounded text-[10.5px]">requires_keys</code> in TOOL.md). On this
          machine the agent's shell can still read the keychain.
        </p>
      </div>
      <details className="group">
        <summary className="flex items-center justify-between cursor-pointer list-none text-[12px] text-foreground/90 py-0.5">
          <span>Other providers (optional)</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {(() => {
              const n = (["anthropic", "openai", "google"] as ProviderId[]).filter((p) => apiKeys[p]).length;
              return n ? `${n} set` : "";
            })()}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60 group-open:rotate-180 transition-transform" />
          </span>
        </summary>
        <div className="space-y-2.5 pt-2">{(["anthropic", "openai", "google"] as ProviderId[]).map(provider)}</div>
      </details>
    </section>
  );
}

// ---- Voice -------------------------------------------------------------------

function VoiceSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const hasKey = useStore((s) => !!s.serviceKeys.elevenlabs);
  const [voiceId, setVoiceId] = useState(
    localStorage.getItem("vault_chat_elevenlabs_voice") ?? "nPczCjzI2devNBz1zQrb",
  );
  const [library, setLibrary] = useState<SavedVoice[]>(() => {
    const cached = readVoiceLibraryCache();
    return cached.length ? cached : DEFAULT_VOICES;
  });
  // The saved voices are git-synced via <vault>/.vault-chat/voices.json. On
  // open, load them from the vault; if the vault has none yet, seed it from
  // what's local so it starts syncing.
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    (async () => {
      const fromVault = await readVoiceLibrary(vaultPath);
      if (cancelled) return;
      if (fromVault) setLibrary(fromVault);
      else await writeVoiceLibrary(vaultPath, library);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath]);
  const pickerRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = pickerRef.current;
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");

  const choose = (id: string) => {
    const v = id.trim();
    if (!v) return;
    localStorage.setItem("vault_chat_elevenlabs_voice", v);
    setVoiceId(v);
    if (pickerRef.current) pickerRef.current.open = false;
  };
  const addVoice = () => {
    const name = newName.trim();
    const id = newId.trim();
    if (!name || !id) return;
    const next = [...library.filter((v) => v.id !== id), { name, id }];
    setLibrary(next);
    void writeVoiceLibrary(vaultPath, next);
    setNewName("");
    setNewId("");
    choose(id);
  };
  const removeVoice = (id: string) => {
    const next = library.filter((v) => v.id !== id);
    setLibrary(next);
    void writeVoiceLibrary(vaultPath, next);
  };

  return (
    <section className="space-y-2">
      <SectionHead
        title="Voice"
        hint={hasKey ? "The voice ElevenLabs speaks with. The voice model is under Models." : "Needs an ElevenLabs key (Keys)."}
      />
      <details ref={pickerRef} className="w-full rounded-md border border-input bg-background group">
        <summary className="h-8 px-2.5 flex items-center justify-between cursor-pointer text-[12px] font-mono list-none">
          <span className="truncate">
            {library.find((v) => v.id === voiceId)?.name ?? "(unsaved)"}
            <span className="ml-2 text-muted-foreground/60">{voiceId}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-open:rotate-180 transition-transform" />
        </summary>
        <div className="border-t border-border max-h-48 overflow-y-auto">
          {library.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-muted-foreground/70">No saved voices yet. Add one below.</div>
          )}
          {library.map((v) => (
            <div
              key={v.id}
              className={`flex items-center justify-between px-2 py-1.5 text-[12px] cursor-pointer hover:bg-muted/40 ${v.id === voiceId ? "bg-muted/60" : ""}`}
              onClick={() => choose(v.id)}
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
                  removeVoice(v.id);
                }}
                title="Remove from library"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </details>
      <div className="flex gap-2">
        <Input type="text" placeholder="Name (e.g. Rachel)" value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-[2]" />
        <Input
          type="text"
          placeholder="Voice ID"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addVoice();
          }}
          className="flex-[3] font-mono"
        />
        <Button size="sm" onClick={addVoice} disabled={!newName.trim() || !newId.trim()}>
          Add
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground/80">Voice IDs are on elevenlabs.io/app/voice-library.</p>
    </section>
  );
}

// ---- Safety, Appearance ------------------------------------------------------

function SafetySection() {
  const strictVaultMode = useStore((s) => s.strictVaultMode);
  const bashDisabled = useStore((s) => s.bashDisabled);
  const setStrictVaultMode = useStore((s) => s.setStrictVaultMode);
  const setBashDisabled = useStore((s) => s.setBashDisabled);
  const toggle = (checked: boolean, set: (v: boolean) => void, title: string, hint: string) => (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input type="checkbox" className="vc-checkbox mt-0.5" checked={checked} onChange={(e) => set(e.target.checked)} />
      <div className="flex-1">
        <div className="text-[12px]">{title}</div>
        <p className="text-[11px] text-muted-foreground/80">{hint}</p>
      </div>
    </label>
  );
  return (
    <section className="space-y-3">
      <SectionHead title="Safety" hint="Limit what the agent can touch." />
      {toggle(
        strictVaultMode,
        setStrictVaultMode,
        "Strict vault mode",
        "File tools refuse paths outside this vault. Turns Bash off too, since the shell would get around it.",
      )}
      {toggle(bashDisabled, setBashDisabled, "Disable Bash", "Removes the shell tool from the agent.")}
    </section>
  );
}

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <section className="space-y-2">
      <SectionHead title="Appearance" />
      <MenuSelect
        value={theme}
        onChange={(v) => setTheme(v as "graphite" | "light")}
        groups={[
          {
            options: [
              { value: "graphite", label: "Graphite (default)" },
              { value: "light", label: "Light" },
            ],
          },
        ]}
      />
    </section>
  );
}

// ---- Box ---------------------------------------------------------------------

function BoxSection() {
  const vaultPath = useStore((s) => s.vaultPath);
  const [config, setConfig] = useState<VaultSyncConfig | null>(null);
  const [box, setBox] = useState<BoxConfig | null>(null);
  useEffect(() => {
    if (!vaultPath) {
      setConfig(null);
      setBox(null);
      return;
    }
    let cancelled = false;
    void readVaultSyncConfig(vaultPath).then((c) => !cancelled && setConfig(c));
    void readBoxConfig(vaultPath).then((b) => !cancelled && setBox(b));
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  return (
    <section className="space-y-3">
      <SectionHead
        title="Box"
        hint={
          !vaultPath || !config
            ? "Open a vault to see its sync."
            : box
              ? "This vault syncs with the box: this laptop writes master, the box writes box."
              : "No box for this vault. It syncs with its git remote."
        }
      />
      {vaultPath && config && (box ? <BoxSyncPanel vault={vaultPath} box={box} /> : <GitSync vault={vaultPath} config={config} setConfig={setConfig} />)}
      <PhoneLink />
    </section>
  );
}

/** A vault without a box: the plain git-remote loop. */
function GitSync({ vault, config, setConfig }: { vault: string; config: VaultSyncConfig; setConfig: (c: VaultSyncConfig) => void }) {
  const [remoteDraft, setRemoteDraft] = useState("");
  const [snapshot, setSnapshot] = useState({
    lastSyncedAt: null as number | null,
    lastMessage: "",
    lastError: null as string | null,
    running: false,
    remote: null as string | null,
    hasChanges: false,
    ahead: 0,
    nestedRepos: [] as string[],
  });
  const [busy, setBusy] = useState(false);
  const [repoNameDraft, setRepoNameDraft] = useState("");
  const [creatingRepo, setCreatingRepo] = useState(false);
  useEffect(() => subscribeSyncStatus(setSnapshot), []);
  useEffect(() => {
    if (snapshot.remote && !remoteDraft) setRemoteDraft(snapshot.remote);
  }, [snapshot.remote, remoteDraft]);

  const toggleEnabled = async (next: boolean) => {
    setConfig(await writeVaultSyncConfig(vault, { enabled: next }));
    if (next) await startVaultSyncLoop(vault);
    else stopVaultSyncLoop(vault);
  };
  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.warn("[vault-sync]", e);
    } finally {
      setBusy(false);
    }
  };
  const saveRemote = () =>
    withBusy(async () => {
      await setVaultRemote(vault, remoteDraft.trim());
      if (config.enabled) await startVaultSyncLoop(vault);
    });
  const createGhRepo = () =>
    withBusy(async () => {
      const name = repoNameDraft.trim();
      if (!name) return;
      const result = await vaultGhCreateRepo(vault, name, true);
      if (!result.ok) return console.warn("[vault-sync] gh repo create:", result.message);
      setRepoNameDraft("");
      setCreatingRepo(false);
      if (config.enabled) await startVaultSyncLoop(vault);
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-foreground/90">Auto-sync</span>
        <label className="flex items-center gap-2 shrink-0 cursor-pointer">
          <span className="text-[10.5px] text-muted-foreground">{config.enabled ? "on" : "off"}</span>
          <input type="checkbox" className="vc-checkbox" checked={config.enabled} onChange={(e) => toggleEnabled(e.target.checked)} />
        </label>
      </div>
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
        <button onClick={() => setCreatingRepo(true)} className="text-[10.5px] text-muted-foreground/80 hover:text-foreground underline">
          Create on GitHub (gh repo create)
        </button>
      )}
      {creatingRepo && (
        <div className="flex gap-2">
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
      <div className="flex items-center gap-2 flex-wrap">
        <SyncStatusRow snapshot={snapshot} enabled={config.enabled} />
        <span className="text-[10.5px] text-muted-foreground/70">·</span>
        <button
          onClick={() => withBusy(() => vaultPull(vault))}
          disabled={busy || !snapshot.remote}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          force pull
        </button>
        <button
          onClick={() => withBusy(async () => (await vaultCommitLocal(vault), await vaultPush(vault)))}
          disabled={busy || !snapshot.remote}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          force push
        </button>
      </div>
    </div>
  );
}

// Read-only status of the box sync, plus "Sync now". Everything here comes
// from the last cycle's report (src-tauri/src/box_sync.rs).
function BoxSyncPanel({ vault, box }: { vault: string; box: BoxConfig }) {
  const [st, setSt] = useState<BoxSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => subscribeBoxSync(setSt), []);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  const r = st?.report ?? null;
  const ago = (t: number | null | undefined) => {
    if (!t) return "never";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleString();
  };
  const row = (label: string, value: React.ReactNode, tone?: "warn" | "bad") => (
    <div className="flex items-start gap-3 text-[11.5px]">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 break-words ${tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-500" : "text-foreground/90"}`}
      >
        {value}
      </span>
    </div>
  );
  const syncNow = async () => {
    setBusy(true);
    try {
      await boxSyncNow(vault);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      {row("Box", <span className="font-mono text-[11px]">{`${box.box}/git/${box.vault}.git`}</span>)}
      {row(
        "Last sync",
        st?.running && !r ? "syncing…" : r?.error ? `failed · last good ${ago(st?.lastOkAt)}` : ago(st?.lastOkAt),
        r?.error ? (st?.attention?.level === "red" ? "bad" : "warn") : undefined,
      )}
      {r && row("Waiting for box", `${r.changes_waiting} commit${r.changes_waiting === 1 ? "" : "s"}`)}
      {r?.conflict &&
        row(
          "Merge gate",
          `closed since ${new Date(r.conflict.since).toLocaleString()}: ${r.conflict.files.join(", ")}. Ask the agent: resolve the sync conflict.`,
          "warn",
        )}
      {r && !r.conflict && row("Merge gate", "open")}
      {r && r.big_files.length > 0 &&
        row(
          "Kept out of git",
          r.big_files.map((b) => `${b.path} (${fmtSize(b.size)})`).join(", "),
          "warn",
        )}
      {r &&
        row(
          "GitHub backup",
          r.github_warning ? "failing (see details below)" : r.github_pushed_at ? ago(r.github_pushed_at) : "no github remote, or not yet",
          r.github_warning ? "warn" : undefined,
        )}
      {(r?.error || r?.github_warning) && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground pt-1">
          {[r?.error, r?.github_warning].filter(Boolean).join("\n\n")}
        </pre>
      )}
      <div className="pt-1">
        <button
          onClick={syncNow}
          disabled={busy || !!st?.running}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy || st?.running ? "syncing…" : "sync now"}
        </button>
      </div>
    </div>
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
    ahead: number;
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
  // Unpushed local commits — not "synced" yet. The pull loop flushes
  // these each cycle, so this is normally transient; if it lingers, it's
  // honestly surfacing a push that isn't going through.
  if (snapshot.ahead > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-500">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        {snapshot.ahead} unpushed · pending
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

function PhoneLink() {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { getPhoneChatLink } = await import("./phoneVoice");
      const c = await getPhoneChatLink().catch(() => null);
      if (alive) setLink(c);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">Phone</h4>
      {link ? (
        <div className="flex items-center gap-2">
          <code className="text-[11px] font-mono bg-muted px-2 py-1 rounded truncate flex-1 min-w-0">{link}</code>
          <button
            className="text-[11px] px-2.5 py-1 rounded border border-border hover:bg-muted shrink-0"
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/60">The link appears once Tailscale is up.</p>
      )}
      <p className="text-[11px] text-muted-foreground/70">
        Open it on your phone and add it to the Home Screen. Voice needs the <span className="font-mono">https://</span> link.
      </p>
    </div>
  );
}
