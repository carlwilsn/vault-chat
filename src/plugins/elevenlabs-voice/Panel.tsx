// The ElevenLabs voice plugin's panel (app/elevenlabs-voice, ./index.tsx): the voice ElevenLabs speaks with on every
// call (the account's voices, the ElevenLabs voice library, Test) and the box's voice health. It was Settings' Voice
// section; Settings has no voice section now (the core voice is local: Kokoro, af_heart, nothing to pick).
//
// Carl's pick is unchanged: the `voice` setting record (src/settingsRecords.ts; box:settings' "voice" key), which
// the box's calls speak with (server/main.ts voiceId), and the laptop's first-paint copy in localStorage
// (VOICE_STORAGE). The key is an ordinary key, asked for by name (ELEVENLABS_API_KEY in Settings → Keys).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Play, Square, X } from "lucide-react";
import { useStore, useKey } from "../../store";
import { ELEVENLABS_VOICE_KEY } from "../../appPlugins";
import { saveSetting, useSetting } from "../../settings";
import { Button } from "../../ui";
import { Picker, type PickOption } from "../../SearchPicker";
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
} from "../../voiceLibraryBrowse";
import { panelChanged, registerPanelPart, type PanelView } from "./view";

/** The panel: a dialog over the window while open (the chat's ⋯ menu "ElevenLabs voice", or the plugin's open action). */
export function ElevenLabsVoicePanel({ view }: { view: PanelView }) {
  const open = useSyncExternalStore(view.subscribe, view.get, view.get);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[data-voice-library]")) view.set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, view]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="ElevenLabs voice" data-el="elevenlabs-voice-panel" className="fixed inset-0 z-[90] flex items-start justify-center pt-[12vh] bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && view.set(false)}>
      <div className="w-[440px] max-w-[92vw] rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border">
          <span className="text-[13px] font-semibold">ElevenLabs voice</span>
          <Button data-offer="app/elevenlabs-voice.close" variant="ghost" size="icon" onClick={() => view.set(false)} data-el="elevenlabs-voice-close" title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="p-4">
          <VoiceSection />
        </div>
      </div>
    </div>
  );
}

type ElVoice = VoiceDetail & { name: string; category?: string; labels?: Record<string, string> };

const DEFAULT_VOICE = "nPczCjzI2devNBz1zQrb";

const TEST_LINE = "Hi Carl. This is how I'll sound when we talk in vault-chat.";

/** The voice a call speaks with is a setting (src/settings.ts): a pick is its record, which every device follows. */
async function voiceToBox(voiceId: string): Promise<void> {
  await saveSetting("voice", voiceId).catch(() => null);
}

export function VoiceSection() {
  const key = useKey(ELEVENLABS_VOICE_KEY);
  const shared = useSetting("voice");
  const [voiceId, setVoiceId] = useState(
    localStorage.getItem(VOICE_STORAGE) ?? DEFAULT_VOICE,
  );
  // The voice setting changed elsewhere (the agent, another device): the picker shows it.
  useEffect(() => {
    if (typeof shared === "string" && shared) setVoiceId(shared);
  }, [shared]);
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
    void voiceToBox(id);
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
    void voiceToBox(id);
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

  // What it shows and its controls, for the plugin's offers (./view.ts): the same choose, Test and library button.
  const liveRef = useRef({ choose, test, setBrowsing });
  liveRef.current = { choose, test, setBrowsing };
  const shownRef = useRef<Record<string, unknown>>({});
  shownRef.current = { voiceId, voices: (voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, ...(voiceUnfitReason(v) ? { unfit: voiceUnfitReason(v) } : {}) })), loading: !!key && !voices, browsing, testing, error };
  useEffect(
    () =>
      registerPanelPart("voices", {
        state: () => shownRef.current,
        act: {
          choose: (a) => liveRef.current.choose(String(a.voiceId ?? "")),
          test: () => liveRef.current.test(),
          browse: (a) => liveRef.current.setBrowsing(a.open !== false),
        },
      }),
    [],
  );
  useEffect(() => panelChanged());

  const listed = visibleVoices(voices ?? [], hidden, voiceId);
  const hints = voiceHints(listed);
  const options: PickOption[] = listed.map((v) => {
    const unfit = voiceUnfitReason(v);
    return { value: v.voice_id, label: v.name, hint: unfit ?? hints.get(v.voice_id), disabled: !!unfit && v.voice_id !== voiceId };
  });
  const current = voices?.find((v) => v.voice_id === voiceId)?.name ?? (voices ? "Pick a voice" : "Loading voices…");

  return (
    <section className="space-y-2" data-el="elevenlabs-voice-section">
      <p className="text-[11.5px] text-muted-foreground/80" data-el="elevenlabs-voice-hint">
        {key ? "The voice ElevenLabs speaks with on every call." : "Needs the key ELEVENLABS_API_KEY (Settings → Keys). Without one, calls use the free local voice."}
      </p>
      <VoiceHealthRow />
      {key && (
        <div className="flex gap-2">
          <div className="flex-1 min-w-0" data-el="voice-picker">
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
          <Button data-offer="app/elevenlabs-voice.test" size="sm" variant="outline" onClick={() => void test()} disabled={testing || !voiceId}>
            {testing ? "Playing…" : "Test"}
          </Button>
        </div>
      )}
      {error && <p className="text-[11px] text-amber-500/90">{error}</p>}
    </section>
  );
}

/** Voice readiness is visible even with the microphone off; there is no engine selector. */
function VoiceHealthRow() {
  const vault = useStore((s) => s.vaultPath);
  const [st, setSt] = useState<{ pipeline: boolean; error?: string | null; failure?: { code: string } | null } | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { boxLinkFor, boxGet } = await import("../../boxChat");
      const link = await boxLinkFor(vault).catch(() => null);
      if (!link) return;
      const r = await boxGet(link, "/api/v1/brain/engine", 5000).catch(() => null);
      if (alive && r) setSt({ pipeline: !!r.pipeline, error: r.error, failure: r.failure });
    })();
    return () => {
      alive = false;
    };
  }, [vault]);
  const stRef = useRef({ st, healthOpen });
  stRef.current = { st, healthOpen };
  useEffect(() => registerPanelPart("health", { state: () => ({ open: stRef.current.healthOpen, pipeline: stRef.current.st?.pipeline ?? null, error: stRef.current.st?.error ?? null, failure: stRef.current.st?.failure?.code ?? null }), act: { open: (a) => setHealthOpen(a.open !== false) } }), []);
  useEffect(() => panelChanged());
  if (!st) return null;
  return (
    <div className="flex items-start justify-between gap-3" data-el="voice-health">
      <span className="text-[12px] text-foreground/70 shrink-0 pt-1">Voice</span>
      <div className="min-w-0 flex-1 max-w-[62%] space-y-0.5">
        <div className="flex gap-1">
          <Button data-offer="app/elevenlabs-voice.openHealth" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" data-el="voice-health-open" onClick={() => setHealthOpen(true)}>Health</Button>
        </div>
        <p className="text-[10.5px] text-muted-foreground px-0.5">
          {st.pipeline ? "The agent hears and speaks on the call itself." : "The box’s voice is setting up or unavailable."}
        </p>
        {st.error && <p role="status" data-el="voice-startup-error" className="text-[10.5px] text-destructive px-0.5">{st.error}</p>}
        {healthOpen && <div data-offer="app/elevenlabs-voice.openHealth" role="dialog" aria-modal="true" aria-label="Voice health" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={() => setHealthOpen(false)}>
          <div data-offer="app/elevenlabs-voice.openHealth" className="w-[420px] max-w-[90vw] rounded-lg border border-border bg-card p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">Voice health</h3>
            <p className="text-xs text-muted-foreground">Microphone {useStore.getState().voiceMode ? "on" : "off"} · {st.pipeline ? "Pipeline ready" : "Pipeline unavailable"}</p>
            <p data-el="voice-health-status" className={`text-xs ${st.error ? "text-destructive" : "text-muted-foreground"}`}>{st.error || "No startup error reported."}</p>
            {st.failure && <p className="text-[10px] text-muted-foreground">{st.failure.code}</p>}
            <Button data-offer="app/elevenlabs-voice.openHealth" size="sm" variant="outline" data-el="voice-health-close" onClick={() => setHealthOpen(false)}>Close</Button>
          </div>
        </div>}
      </div>
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

  const libRef = useRef({ setQuery, setAnyUse, play, pick, close, list, query, anyUse, loading, error, playing, adding, hasMore, recommended });
  libRef.current = { setQuery, setAnyUse, play, pick, close, list, query, anyUse, loading, error, playing, adding, hasMore, recommended };
  useEffect(
    () =>
      registerPanelPart("library", {
        state: () => {
          const l = libRef.current;
          const brief = (v: SharedVoice) => ({ id: v.voice_id, name: v.name, ...(v.accent ? { accent: v.accent } : {}), ...(v.gender ? { gender: v.gender } : {}), sample: !!v.preview_url });
          return { query: l.query, anyUse: l.anyUse, loading: l.loading, error: l.error, playing: l.playing, adding: l.adding, more: l.hasMore, results: l.list.slice(0, 30).map(brief), recommended: (l.recommended ?? []).slice(0, 10).map(brief) };
        },
        act: {
          search: (a) => {
            if (typeof a.query === "string") libRef.current.setQuery(a.query);
            if (typeof a.anyUse === "boolean") libRef.current.setAnyUse(a.anyUse);
          },
          preview: (a) => {
            const l = libRef.current;
            const v = [...l.list, ...(l.recommended ?? [])].find((x) => x.voice_id === a.voiceId);
            if (!v) throw new Error(`no voice ${String(a.voiceId)} in the library's list`);
            l.play(v);
          },
          add: (a) => {
            const l = libRef.current;
            const v = [...l.list, ...(l.recommended ?? [])].find((x) => x.voice_id === a.voiceId);
            if (!v) throw new Error(`no voice ${String(a.voiceId)} in the library's list`);
            return l.pick(v);
          },
          close: () => libRef.current.close(),
        },
      }),
    [],
  );
  useEffect(() => panelChanged());

  const row = (v: SharedVoice) => (
    <div key={v.voice_id} className="flex items-start gap-1.5 px-2 py-1.5 hover:bg-accent transition-colors" data-voice={v.voice_id}>
      <button data-offer="app/elevenlabs-voice.previewLibraryVoice"
        onClick={() => play(v)}
        disabled={!v.preview_url}
        title={playing === v.voice_id ? "Stop" : "Play a sample"}
        className="mt-0.5 h-5 w-5 shrink-0 grid place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        {playing === v.voice_id ? <Square className="h-2.5 w-2.5" /> : <Play className="h-3 w-3" />}
      </button>
      <button data-offer="app/elevenlabs-voice.addLibraryVoice" onClick={() => void pick(v)} className="flex-1 min-w-0 text-left" title={v.description ?? v.name}>
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
          <input data-offer="app/elevenlabs-voice.searchLibrary"
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
            <input data-offer="app/elevenlabs-voice.searchLibrary" type="checkbox" checked={anyUse} onChange={(e) => setAnyUse(e.target.checked)} className="h-3 w-3" />
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
