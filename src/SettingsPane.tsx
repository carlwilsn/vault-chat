import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, X, Plus, ChevronDown } from "lucide-react";
import { useStore } from "./store";
import { PROVIDER_LABEL, AUTO_MODEL_ID, type ModelSpec, type ProviderId } from "./providers";
import { Button, Input, MenuSelect } from "./ui";
import { VOICE_LLMS, normalizeVoiceLlm } from "./voiceLlms";
import { listUserKeys, setUserKey, deleteUserKey } from "./keychain";
import {
  readBoxConfig,
  subscribeBoxSync,
  boxSyncNow,
  fmtSize,
  type BoxConfig,
  type BoxSyncState,
  boxName,
  boxVaultName,
  discoverBoxes,
  connectBox,
  disconnectBox,
  type FoundBox,
} from "./vaultSync";
import { boxGet, boxPost } from "./boxChat";
import { pushKeysToBox, keysChanged, subscribeKeyPush } from "./boxKeys";
import { ROLE_LABEL, type RoleId } from "./roles";
import { checkModel, checkVoiceModel, NEED_LABEL, type Check as ModelCheck } from "./modelCaps";
import { BoxModelChecks } from "./BoxModelChecks";

// Five sections: Models, Keys, Voice, Box, Appearance.

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
        <AppearanceSection />
      </div>
    </div>
  );
}

// ---- Models ------------------------------------------------------------------

const VOICE_OPTIONS: PickOption[] = VOICE_LLMS.map((m) => ({ value: m.id, label: m.label }));

type PickOption = { value: string; label: string; hint?: string };

/** The chat pane's model menu, as a Settings field: one tight row; open it and
 *  type to search, or scroll. */
function Picker({
  value,
  label,
  options,
  onChange,
  placeholder = "Search…",
  defaultOpen = false,
}: {
  value: string;
  label?: string;
  options: PickOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => {
        const hay = `${o.label} ${o.value} ${o.hint ?? ""}`.toLowerCase();
        return q.split(/\s+/).every((t) => hay.includes(t));
      })
    : options;
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const current = label ?? options.find((o) => o.value === value)?.label ?? value;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full h-7 px-2.5 flex items-center justify-between gap-2 rounded-md border border-input bg-background text-[12px] hover:border-border transition-colors"
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col">
          <div className="p-1.5 border-b border-border/60">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && shown.length > 0) {
                  e.preventDefault();
                  pick(shown[0].value);
                }
              }}
              placeholder={placeholder}
              className="w-full bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="py-1 max-h-64 overflow-auto">
            {shown.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground italic">No matches</div>
            ) : (
              shown.map((o) => (
                <button
                  key={o.value}
                  onClick={() => pick(o.value)}
                  className={`block w-full text-left px-3 py-1.5 text-[11px] hover:bg-accent transition-colors truncate ${
                    o.value === value ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                  title={o.value}
                >
                  {o.label}
                  {o.hint && <span className="ml-1.5 opacity-60 text-[10px]">{o.hint}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One quiet line under a role's picker: the model passed, or what it can't do. */
function CheckLine({ check }: { check: ModelCheck | null }) {
  if (!check) return null;
  if (check.state === "checking") return <p className="text-[10.5px] text-muted-foreground/60 px-0.5">Checking…</p>;
  if (check.state === "passed")
    return (
      <p className="text-[10.5px] text-muted-foreground/70 px-0.5 flex items-center gap-1">
        <Check className="h-3 w-3" /> Passed
      </p>
    );
  if (check.state === "missing")
    return (
      <p className="text-[10.5px] text-amber-500/90 px-0.5">
        Can't {check.missing.map((n) => NEED_LABEL[n]).join(" or ")}. Pick another.
      </p>
    );
  return <p className="text-[10.5px] text-muted-foreground/60 px-0.5">Not checked: {check.why}</p>;
}

/** Re-check whenever the picked model changes. */
function useCheck(run: () => Promise<ModelCheck> | ModelCheck, dep: string): ModelCheck | null {
  const [check, setCheck] = useState<ModelCheck | null>(null);
  useEffect(() => {
    let alive = true;
    const r = run();
    if (r instanceof Promise) {
      setCheck({ state: "checking" });
      void r.then((c) => alive && setCheck(c));
    } else setCheck(r);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return check;
}

function ModelsSection() {
  const catalog = useStore((s) => s.catalog);
  const catalogErrors = useStore((s) => s.catalogErrors);
  const orKey = useStore((s) => s.apiKeys.openrouter);
  const modelId = useStore((s) => s.modelId);
  const setModelId = useStore((s) => s.setModelId);
  const setAssistantModelId = useStore((s) => s.setAssistantModelId);
  const backgroundModelId = useStore((s) => s.backgroundModelId);
  const setBackgroundModelId = useStore((s) => s.setBackgroundModelId);
  const autoRouterCostBias = useStore((s) => s.autoRouterCostBias);
  const setAutoRouterCostBias = useStore((s) => s.setAutoRouterCostBias);

  const [voiceLlm, setVoiceLlm] = useState(() => {
    // An old id shows as its nearest current one; nothing chosen is the default.
    return normalizeVoiceLlm(localStorage.getItem("vault_chat_elevenlabs_llm"));
  });
  const saveVoiceLlm = (v: string) => {
    localStorage.setItem("vault_chat_elevenlabs_llm", v);
    setVoiceLlm(v);
  };

  const options = (withAuto: boolean): PickOption[] => [
    ...(withAuto ? [{ value: AUTO_MODEL_ID, label: "Auto", hint: "— smart routing" }] : []),
    ...catalog.map((m: ModelSpec) => ({ value: m.id, label: m.label })),
  ];
  const labelOf = (id: string) => (id === AUTO_MODEL_ID ? "Auto" : (catalog.find((c) => c.id === id)?.label ?? id.split("/").pop()!));

  // Auto routes per message, so there's no one model to check.
  const chatCheck = useCheck(
    () => (modelId === AUTO_MODEL_ID ? Promise.resolve<ModelCheck>({ state: "passed" }) : checkModel("chat", modelId, orKey)),
    `${modelId}|${!!orKey}`,
  );
  const bgCheck = useCheck(() => checkModel("background", backgroundModelId, orKey), `${backgroundModelId}|${!!orKey}`);
  const elKey = useStore((s) => s.serviceKeys.elevenlabs);
  const voiceCheck = useCheck(() => checkVoiceModel(voiceLlm, elKey), `${voiceLlm}|${!!elKey}`);

  const rows: Array<{ role: RoleId; picker: ReactNode; check: ModelCheck | null }> = [
    {
      role: "chat",
      picker: (
        <Picker
          value={modelId}
          label={labelOf(modelId)}
          options={options(true)}
          placeholder="Search models…"
          onChange={(v) => {
            setModelId(v);
            setAssistantModelId(v);
          }}
        />
      ),
      check: chatCheck,
    },
    {
      role: "background",
      picker: (
        <Picker
          value={backgroundModelId}
          label={labelOf(backgroundModelId)}
          options={options(false)}
          placeholder="Search models…"
          onChange={setBackgroundModelId}
        />
      ),
      check: bgCheck,
    },
    {
      role: "voice",
      picker: <Picker value={voiceLlm} options={VOICE_OPTIONS} placeholder="Search models…" onChange={saveVoiceLlm} />,
      check: voiceCheck,
    },
  ];

  return (
    <section className="space-y-2">
      <SectionHead title="Models" hint="One model per role. Each is checked for what its role needs when you pick it." />
      {rows.map((r) => (
        <div key={r.role} className="flex items-start justify-between gap-3">
          <span className="text-[12px] text-foreground/90 shrink-0 pt-1">{ROLE_LABEL[r.role]}</span>
          <div className="min-w-0 flex-1 max-w-[62%] space-y-0.5">
            {r.picker}
            <CheckLine check={r.check} />
          </div>
        </div>
      ))}
      <BoxModelChecks />
      {Object.entries(catalogErrors).length > 0 && (
        <p className="text-[11px] text-amber-500/90">
          {Object.entries(catalogErrors)
            .map(([p, msg]) => `${p}: ${msg}`)
            .join(" · ")}
        </p>
      )}
      {modelId === AUTO_MODEL_ID && orKey && (
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
    </section>
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
  // Any add / change / removal here goes to the connected box too (the whole
  // set; see boxKeys.ts). Not on first render: connecting already pushed.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = window.setTimeout(() => void keysChanged(), 400);
    return () => window.clearTimeout(t);
  }, [apiKeys, serviceKeys, names]);

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
          <code className="font-mono bg-muted px-1 rounded text-[10.5px]">requires_keys</code> in TOOL.md).
        </p>
      </div>
    </section>
  );
}

// ---- Voice -------------------------------------------------------------------

type ElVoice = { voice_id: string; name: string; category?: string; labels?: Record<string, string> };

const TEST_LINE = "Hi Carl. This is how I'll sound when we talk in vault-chat.";

function VoiceSection() {
  const key = useStore((s) => s.serviceKeys.elevenlabs);
  const [voiceId, setVoiceId] = useState(
    localStorage.getItem("vault_chat_elevenlabs_voice") ?? "nPczCjzI2devNBz1zQrb",
  );
  // The voices on the ElevenLabs account (its default voices plus any added
  // from the library or cloned), straight from the API.
  const [voices, setVoices] = useState<ElVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
        const j = (await res.json()) as { voices: ElVoice[] };
        if (alive) setVoices([...j.voices].sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  const choose = (id: string) => {
    localStorage.setItem("vault_chat_elevenlabs_voice", id);
    setVoiceId(id);
  };

  // Test: speak one short line in the picked voice (about 60 characters of
  // the ElevenLabs quota).
  const [testing, setTesting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const test = async () => {
    if (!key) return;
    audioRef.current?.pause();
    setTesting(true);
    setError(null);
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: TEST_LINE, model_id: "eleven_flash_v2_5" }),
      });
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        setTesting(false);
      };
      await a.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTesting(false);
    }
  };
  useEffect(() => () => audioRef.current?.pause(), []);

  const describe = (v: ElVoice) =>
    [v.labels?.accent, v.labels?.gender, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(", ");
  const options: PickOption[] = (voices ?? []).map((v) => ({ value: v.voice_id, label: v.name, hint: describe(v) }));
  const current = voices?.find((v) => v.voice_id === voiceId)?.name ?? (voices ? "Pick a voice" : "Loading voices…");

  return (
    <section className="space-y-2">
      <SectionHead title="Voice" hint={key ? "The voice ElevenLabs speaks with." : "Needs an ElevenLabs key (Keys)."} />
      {key && (
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <Picker value={voiceId} label={current} options={options} placeholder="Search voices…" onChange={choose} />
          </div>
          <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing || !voiceId}>
            {testing ? "Playing…" : "Test"}
          </Button>
        </div>
      )}
      {error && <p className="text-[11px] text-amber-500/90">{error}</p>}
    </section>
  );
}

// ---- Appearance --------------------------------------------------------------

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
  // undefined = still reading sync.json; null = no box (runs on this laptop).
  const [box, setBox] = useState<BoxConfig | null | undefined>(undefined);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!vaultPath) {
      setBox(undefined);
      return;
    }
    let cancelled = false;
    void readBoxConfig(vaultPath).then((b) => !cancelled && setBox(b));
    return () => {
      cancelled = true;
    };
  }, [vaultPath, rev]);
  // Connect / disconnect: re-read sync.json, and move the chat (box mode is
  // decided when the conversations load).
  const changed = async (connected: boolean) => {
    if (!connected) (await import("./boxChat")).stopBoxChat();
    setRev((n) => n + 1);
    void useStore.getState().loadConversations();
  };

  // Sync exists only with a box. Without one, the vault is saved locally for
  // history (always on, no setting) and nothing is pushed anywhere.
  return (
    <section className="space-y-3">
      <SectionHead
        title="Box"
        hint={!vaultPath || box === undefined ? "Open a vault to see its sync." : box ? `Runs on ${boxName(box)}` : "Runs on this laptop"}
      />
      {vaultPath &&
        box !== undefined &&
        (box ? (
          <BoxSyncPanel vault={vaultPath} box={box} onDisconnected={() => void changed(false)} />
        ) : (
          <BoxConnect vault={vaultPath} onConnected={() => void changed(true)} />
        ))}
      <PhoneLink box={box ?? null} />
    </section>
  );
}

type BoxHealth = { name: string; version: string | null };

/** Not connected: find a box on the tailnet (or type its address), then sync
 *  this vault with it — which also gives it this laptop's keys (boxKeys.ts). */
function BoxConnect({ vault, onConnected }: { vault: string; onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<FoundBox[] | null>(null);
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [health, setHealth] = useState<BoxHealth | null>(null);
  const laptopKey = useStore((s) => s.apiKeys.openrouter);
  const [busy, setBusy] = useState<null | "checking" | "sync">(null);
  const [error, setError] = useState<string | null>(null);
  const link = (url: string) => ({ url, token: useStore.getState().boxToken || null });

  const start = async () => {
    setOpen(true);
    setFound(null);
    setError(null);
    try {
      setFound(await discoverBoxes());
    } catch (e) {
      setFound([]);
      setError(`Couldn't list the tailnet: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const check = async (raw: string) => {
    let url = raw.trim().replace(/\/+$/, "");
    if (!url) return;
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    const fallback = found?.find((b) => b.url === url)?.name ?? url.replace(/^https?:\/\//, "").split(".")[0];
    setPicked(url);
    setHealth(null);
    setError(null);
    setBusy("checking");
    try {
      const h = await boxGet(link(url), "/api/v1/health", 6000);
      const isServer = h?.app === "vault-chat-server" || (h?.ok === true && h?.version && h?.keys);
      if (!isServer) throw new Error("it doesn't answer as a vault-chat server");
      setHealth({ name: h.name || fallback, version: h.version ?? null });
    } catch (e) {
      setError(`${fallback} didn't answer: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const sync = async () => {
    if (!picked || !health) return;
    setBusy("sync");
    setError(null);
    try {
      const r = await boxPost(link(picked), "/api/v1/vaults", { name: boxVaultName(vault) });
      if (!r.ok) throw new Error(r.error ?? "the box refused");
      const keyErr = await pushKeysToBox(picked);
      if (keyErr) throw new Error(`your keys didn't reach it (${keyErr})`);
      await connectBox(vault, picked, health.name);
      onConnected();
    } catch (e) {
      setError(`Couldn't sync with ${health.name}: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => void start()}>
        Connect a box
      </Button>
    );
  }
  const options: PickOption[] = (found ?? []).map((b) => ({
    value: b.url,
    label: b.name,
    hint: b.online ? `online${b.version ? ` · v${b.version}` : ""}` : "offline",
  }));
  return (
    <div className="space-y-2 rounded-md border border-border/60 px-2.5 py-2">
      {!health ? (
        <>
          <Picker
            value={picked ?? ""}
            label={found === null ? "Looking for boxes…" : found.length ? "Pick a box" : "No box answered on your tailnet"}
            options={options}
            placeholder="Search boxes…"
            onChange={(v) => void check(v)}
            defaultOpen
          />
          <div className="flex gap-2">
            <Input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void check(address)}
              placeholder="Or enter an address"
              className="font-mono text-[11.5px]"
            />
            <Button size="sm" variant="outline" onClick={() => void check(address)} disabled={!address.trim() || busy === "checking"}>
              Check
            </Button>
          </div>
          {busy === "checking" && <p className="text-[10.5px] text-muted-foreground/70">Checking…</p>}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="min-w-0 truncate">
              <span className="text-foreground/90">{health.name}</span>
              <span className="text-muted-foreground">{health.version ? ` · v${health.version}` : ""}</span>
            </span>
            <button onClick={() => setHealth(null)} className="text-[10.5px] text-muted-foreground hover:text-foreground underline shrink-0">
              change
            </button>
          </div>
          {!laptopKey && <p className="text-[11px] text-muted-foreground/80">Add your OpenRouter key under Keys first.</p>}
          <Button size="sm" onClick={() => void sync()} disabled={!laptopKey || busy === "sync"}>
            {busy === "sync" ? "Syncing…" : `Sync this vault with ${health.name}`}
          </Button>
        </>
      )}
      {error && (
        <p className="text-[11px] text-amber-500/90 break-words">
          {error}
          {health && busy === null && (
            <button onClick={() => void sync()} className="ml-1.5 underline hover:text-foreground">
              Retry
            </button>
          )}
        </p>
      )}
      <button
        onClick={() => {
          setOpen(false);
          setHealth(null);
          setPicked(null);
          setError(null);
        }}
        className="block text-[10.5px] text-muted-foreground hover:text-foreground underline"
      >
        cancel
      </button>
    </div>
  );
}

// Read-only status of the box sync, plus "Sync now". Everything here comes
// from the last cycle's report (src-tauri/src/box_sync.rs).
function BoxSyncPanel({ vault, box, onDisconnected }: { vault: string; box: BoxConfig; onDisconnected: () => void }) {
  const [st, setSt] = useState<BoxSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [discError, setDiscError] = useState<string | null>(null);
  const [keyFail, setKeyFail] = useState<string | null>(null);
  useEffect(() => subscribeKeyPush(setKeyFail), []);
  const disconnect = async () => {
    setBusy(true);
    setDiscError(null);
    try {
      await disconnectBox(vault);
      onDisconnected();
    } catch (e) {
      setDiscError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
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
      <div className="pt-1 flex items-center gap-2">
        <button
          onClick={syncNow}
          disabled={busy || !!st?.running}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy || st?.running ? "syncing…" : "sync now"}
        </button>
        <span className="text-[10.5px] text-muted-foreground/70">·</span>
        <button
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="text-[10.5px] text-muted-foreground hover:text-foreground underline disabled:opacity-40 disabled:cursor-not-allowed"
        >
          disconnect
        </button>
      </div>
      {confirming && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] text-foreground/90">
            Disconnect {boxName(box)}? Chat goes back to running on this laptop. {boxName(box)} keeps its copy of this vault.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {discError && <p className="text-[11px] text-destructive">{discError}</p>}
      {keyFail && (
        <p className="text-[11px] text-amber-500/90 break-words pt-1">
          Your keys didn't reach {boxName(box)}: {keyFail}
          <button onClick={() => void pushKeysToBox(box.box)} className="ml-1.5 underline hover:text-foreground">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

/** The phone app's one home is the box (always on): its fixed https link, no
 *  token — the box knows the phone by its Tailscale login. */
function PhoneLink({ box }: { box: BoxConfig | null }) {
  const [copied, setCopied] = useState(false);
  const link = box ? `${box.box.replace(/\/+$/, "")}/phone` : null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">Phone</h4>
      {link ? (
        <>
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
          <p className="text-[11px] text-muted-foreground/70">Open it on your phone (signed in to Tailscale) and add it to the Home Screen.</p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">The phone app runs on a box — connect one above.</p>
      )}
    </div>
  );
}
