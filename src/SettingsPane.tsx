import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, X, Plus, ChevronDown, Play, Square } from "lucide-react";
import { useStore } from "./store";
import { PROVIDER_LABEL, AUTO_MODEL_ID, type ModelSpec, type ProviderId } from "./providers";
import { Button, Input, MenuSelect } from "./ui";
import { VOICE_LLMS, normalizeVoiceLlm } from "./voiceLlms";
import { setVoiceInputDevice, voiceInputDevice } from "./voice-elevenlabs";
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
import {
  fetchSharedVoices,
  recommendedVoices,
  pickLibraryVoice,
  describeShared,
  selectVoice,
  readHidden,
  snapshotHidden,
  visibleVoices,
  VOICE_STORAGE,
  voiceHints,
  voiceUnfitReason,
  checkVoiceFits,
  type SharedVoice,
  type VoiceDetail,
} from "./voiceLibraryBrowse";

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

/** `disabled`: shown, not pickable (its hint says why). */
type PickOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** The chat pane's model menu, as a Settings field: one tight row; open it and
 *  type to search, or scroll. */
function Picker({
  value,
  label,
  options,
  onChange,
  placeholder = "Search…",
  defaultOpen = false,
  footer,
}: {
  value: string;
  label?: string;
  options: PickOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  defaultOpen?: boolean;
  /** One quiet action under the list (it closes the menu). */
  footer?: { label: string; onClick: () => void };
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
                } else if (e.key === "Enter" && shown.some((o) => !o.disabled)) {
                  e.preventDefault();
                  pick(shown.find((o) => !o.disabled)!.value);
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
                  onClick={() => !o.disabled && pick(o.value)}
                  disabled={o.disabled}
                  aria-disabled={o.disabled || undefined}
                  className={`block w-full text-left px-3 py-1.5 text-[11px] transition-colors truncate ${
                    o.disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-accent"
                  } ${o.value === value ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  title={o.disabled && o.hint ? o.hint : o.value}
                  data-option={o.value}
                >
                  {o.label}
                  {o.hint && <span className="ml-1.5 opacity-60 text-[10px]">{o.hint}</span>}
                </button>
              ))
            )}
          </div>
          {footer && (
            <button
              onClick={() => {
                setOpen(false);
                footer.onClick();
              }}
              className="block w-full text-left px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground border-t border-border/60 transition-colors"
            >
              {footer.label}
            </button>
          )}
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

type ElVoice = VoiceDetail & { name: string; category?: string; labels?: Record<string, string> };

const DEFAULT_VOICE = "nPczCjzI2devNBz1zQrb";

const TEST_LINE = "Hi Carl. This is how I'll sound when we talk in vault-chat.";

function VoiceSection() {
  const key = useStore((s) => s.serviceKeys.elevenlabs);
  const [voiceId, setVoiceId] = useState(
    localStorage.getItem(VOICE_STORAGE) ?? DEFAULT_VOICE,
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
        if (!alive) return;
        setHidden(snapshotHidden(j.voices.map((v) => v.voice_id), localStorage.getItem(VOICE_STORAGE) ?? DEFAULT_VOICE));
        setVoices([...j.voices].sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  // A voice the agent can't speak with (voiceUnfitReason) is never selected:
  // the list marks it, and a pick asks ElevenLabs for the voice's own record first.
  const choose = async (id: string) => {
    setError(null);
    const listed = voices?.find((v) => v.voice_id === id);
    const unfit = (listed && voiceUnfitReason(listed)) || (key ? await checkVoiceFits(key, id) : null);
    if (unfit) {
      setError(`${listed?.name ?? "That voice"}: ${unfit}.`);
      return;
    }
    selectVoice(id);
    setVoiceId(id);
    if (useStore.getState().voiceMode) setError("The new voice starts with the next voice session.");
  };
  const [browsing, setBrowsing] = useState(false);
  // Hidden voices (ids, never names): a one-time snapshot of the account's
  // voices other than the selected one, taken the first time the list loads
  // (snapshotHidden). The dropdown leaves them out; a voice added later shows.
  const [hidden, setHidden] = useState(() => readHidden());
  // A library voice was picked (added to the account, or already in it): it
  // joins the account's list here at once.
  const pickedFromLibrary = (id: string, v: SharedVoice) => {
    setVoiceId(id);
    setBrowsing(false);
    setHidden(readHidden());
    setVoices((cur) =>
      cur && !cur.some((x) => x.voice_id === id)
        ? [...cur, { voice_id: id, name: v.name, labels: { accent: v.accent ?? "", gender: v.gender ?? "", description: v.description ?? "" } }].sort((a, b) =>
            a.name.localeCompare(b.name),
          )
        : cur,
    );
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
        body: JSON.stringify({ text: TEST_LINE, model_id: "eleven_flash_v2" }),
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

  const listed = visibleVoices(voices ?? [], hidden, voiceId);
  const hints = voiceHints(listed);
  const options: PickOption[] = listed.map((v) => {
    const unfit = voiceUnfitReason(v);
    return { value: v.voice_id, label: v.name, hint: unfit ?? hints.get(v.voice_id), disabled: !!unfit && v.voice_id !== voiceId };
  });
  const current = voices?.find((v) => v.voice_id === voiceId)?.name ?? (voices ? "Pick a voice" : "Loading voices…");

  return (
    <section className="space-y-2">
      <SectionHead title="Voice" hint={key ? "The voice ElevenLabs speaks with." : "Needs an ElevenLabs key (Keys)."} />
      {key && (
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            {browsing ? (
              <LibraryPicker
                elKey={key}
                owned={new Set((voices ?? []).map((v) => v.voice_id))}
                onPicked={pickedFromLibrary}
                onClose={() => setBrowsing(false)}
              />
            ) : (
              <Picker
                value={voiceId}
                label={current}
                options={options}
                placeholder="Search voices…"
                onChange={(id) => void choose(id)}
                footer={{ label: "Browse the voice library…", onClick: () => setBrowsing(true) }}
              />
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing || !voiceId}>
            {testing ? "Playing…" : "Test"}
          </Button>
        </div>
      )}
      {error && <p className="text-[11px] text-amber-500/90">{error}</p>}
      <MicPicker />
    </section>
  );
}

/** The microphone voice listens with: the system default, or one input
 *  (the SDK's inputDeviceId; a live call switches at once). */
function MicPicker() {
  const [mic, setMic] = useState(() => voiceInputDevice());
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const load = () =>
      void md
        .enumerateDevices()
        .then((ds) => alive && setInputs(ds.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")))
        .catch(() => undefined);
    load();
    md.addEventListener?.("devicechange", load);
    return () => {
      alive = false;
      md.removeEventListener?.("devicechange", load);
    };
  }, []);
  const missing = !!mic && inputs.length > 0 && !inputs.some((d) => d.deviceId === mic);
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">Microphone</div>
      <MenuSelect
        value={mic}
        onChange={(v) => {
          setMic(v);
          void setVoiceInputDevice(v);
        }}
        groups={[
          {
            options: [
              { value: "", label: "System default" },
              ...inputs.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
              ...(missing ? [{ value: mic, label: "The picked microphone (not connected)" }] : []),
            ],
          },
        ]}
      />
    </div>
  );
}

/** The ElevenLabs voice library, as the same search-and-scroll menu:
 *  Recommended on top (before a search), then English conversational voices
 *  by recent use, 30 a page as it scrolls. The play button plays a voice's
 *  preview (one at a time; closing stops it); a click adds it to the account
 *  and selects it. */
function LibraryPicker({
  elKey,
  owned,
  onPicked,
  onClose,
}: {
  elKey: string;
  owned: ReadonlySet<string>;
  onPicked: (id: string, v: SharedVoice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [anyUse, setAnyUse] = useState(false);
  const [recommended, setRecommended] = useState<SharedVoice[] | null>(null);
  const [list, setList] = useState<SharedVoice[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const gen = useRef(0);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  const close = () => {
    stop();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void recommendedVoices(elKey)
      .then((r) => alive && setRecommended(r))
      .catch(() => alive && setRecommended([]));
    return () => {
      alive = false;
    };
  }, [elKey]);

  const load = async (p: number, search: string, any: boolean) => {
    const g = gen.current;
    setLoading(true);
    try {
      const r = await fetchSharedVoices(elKey, { page: p, search, anyUse: any });
      if (g !== gen.current) return;
      setList((cur) => (p === 0 ? r.voices : [...cur, ...r.voices.filter((v) => !cur.some((c) => c.voice_id === v.voice_id))]));
      setHasMore(r.hasMore);
      setPage(p);
    } catch (e) {
      if (g === gen.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  };
  // A new search or use filter starts over at page 0 (typing settles first).
  useEffect(() => {
    gen.current++;
    setList([]);
    setHasMore(true);
    setError(null);
    const t = setTimeout(() => void load(0, query, anyUse), query ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, anyUse, elKey]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!loading && hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 60) void load(page + 1, query, anyUse);
  };

  const play = (v: SharedVoice) => {
    if (playing === v.voice_id) return stop();
    stop();
    if (!v.preview_url) return;
    const a = new Audio(v.preview_url);
    audioRef.current = a;
    setPlaying(v.voice_id);
    a.onended = () => {
      if (audioRef.current === a) setPlaying(null);
    };
    a.play().catch(() => {
      if (audioRef.current === a) setPlaying(null);
    });
  };

  const pick = async (v: SharedVoice) => {
    if (adding) return;
    setAdding(v.voice_id);
    setError(null);
    const r = await pickLibraryVoice(elKey, v, owned);
    setAdding(null);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    stop();
    onPicked(r.voiceId, v);
  };

  const row = (v: SharedVoice) => (
    <div key={v.voice_id} className="flex items-start gap-1.5 px-2 py-1.5 hover:bg-accent transition-colors" data-voice={v.voice_id}>
      <button
        onClick={() => play(v)}
        disabled={!v.preview_url}
        title={playing === v.voice_id ? "Stop" : "Play a sample"}
        className="mt-0.5 h-5 w-5 shrink-0 grid place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        {playing === v.voice_id ? <Square className="h-2.5 w-2.5" /> : <Play className="h-3 w-3" />}
      </button>
      <button onClick={() => void pick(v)} className="flex-1 min-w-0 text-left" title={v.description ?? v.name}>
        <div className="text-[11px] text-foreground truncate">
          {v.name}
          <span className="ml-1.5 opacity-60 text-[10px]">{describeShared(v)}</span>
          {adding === v.voice_id && <span className="ml-1.5 opacity-60 text-[10px]">Adding…</span>}
        </div>
        {v.description && <div className="text-[10.5px] text-muted-foreground truncate">{v.description}</div>}
      </button>
    </div>
  );

  const head = (t: string) => <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">{t}</div>;
  const showRec = !query.trim() && !anyUse && !!recommended?.length;
  return (
    <div className="relative" ref={ref}>
      <div className="w-full h-7 px-2.5 flex items-center rounded-md border border-input bg-background text-[12px] text-muted-foreground">
        Voice library
      </div>
      <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col" data-voice-library>
        <div className="p-1.5 border-b border-border/60 flex items-center gap-2">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Search the library…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] px-2 py-1 rounded border border-transparent focus:border-border placeholder:text-muted-foreground/60"
          />
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0 pr-1 cursor-pointer" title="Not only voices made for conversation">
            <input type="checkbox" checked={anyUse} onChange={(e) => setAnyUse(e.target.checked)} className="h-3 w-3" />
            All uses
          </label>
        </div>
        {error && <p className="px-3 py-1.5 text-[11px] text-amber-500/90 border-b border-border/60">{error}</p>}
        <div className="py-1 max-h-72 overflow-auto" onScroll={onScroll}>
          {showRec && (
            <>
              {head("Recommended")}
              {recommended!.map(row)}
              {head("Most used lately")}
            </>
          )}
          {list.map(row)}
          {loading && <div className="px-3 py-2 text-[11px] text-muted-foreground/70">Loading…</div>}
          {!loading && list.length === 0 && !error && <div className="px-3 py-2 text-[11px] text-muted-foreground italic">No matches</div>}
        </div>
      </div>
    </div>
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
  const [copied, setCopied] = useState<"phone" | "board" | null>(null);
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
                setCopied("phone");
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === "phone" ? "copied" : "copy"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Open it on your phone (signed in to Tailscale) and add it to the Home Screen.</p>
          {/* The whiteboard (board/README.md): the same box, at /board. */}
          <h4 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70 pt-2">Whiteboard (iPad)</h4>
          <div className="flex items-center gap-2">
            <code className="text-[11px] font-mono bg-muted px-2 py-1 rounded truncate flex-1 min-w-0">{link.replace(/\/phone$/, "/board")}</code>
            <button
              className="text-[11px] px-2.5 py-1 rounded border border-border hover:bg-muted shrink-0"
              onClick={() => {
                void navigator.clipboard?.writeText(link.replace(/\/phone$/, "/board"));
                setCopied("board");
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === "board" ? "copied" : "copy"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">Open it on the iPad (signed in to Tailscale) and add it to the Home Screen; boards are saved in the vault's hidden boards/ folder.</p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">The phone app runs on a box — connect one above.</p>
      )}
    </div>
  );
}
