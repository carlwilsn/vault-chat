// Speech Rule Engine's configuration for server/speakMath.ts, set BEFORE SRE is imported: SRE starts loading
// its maps from disk as soon as it runs (the box has only the bundle, no node_modules), and it applies a global
// `SREfeature` to every setup — its own start-up included. So the maps always come from here: SRE's own
// (bundled), with physics units and the long names for lim, sup and inf.
import enMaps from "speech-rule-engine/lib/mathmaps/en.json";
import baseMaps from "speech-rule-engine/lib/mathmaps/base.json";

/** ClearSpeak preferences: | between arguments is "given" (P(s'|s,a)), Δ is "Delta" (not "triangle"), ∈ is "in". */
export const CLEARSPEAK_STYLE = "VerticalLine_Given:TriangleSymbol_Delta:SetMemberSymbol_In";

type Rule = { key?: string; names?: string[]; si?: boolean; category?: string; mappings?: Record<string, Record<string, string>>; locale?: string };
type Maps = Record<string, Rule[]>;

/** Physics units SRE lacks or names for another field (its C is Celsius, its F Fahrenheit). */
const PHYSICS_UNITS: { key: string; names: string[]; si: boolean; one: string; many?: string }[] = [
  { key: "coulomb", names: ["C"], si: true, one: "coulomb" },
  { key: "farad", names: ["F"], si: true, one: "farad" },
  { key: "tesla", names: ["T"], si: true, one: "tesla" },
  { key: "hertz", names: ["Hz"], si: true, one: "hertz", many: "hertz" },
  { key: "pascal", names: ["Pa"], si: true, one: "pascal" },
  { key: "electronvolt", names: ["eV"], si: true, one: "electron volt" },
  { key: "mole", names: ["mol"], si: false, one: "mole" },
  { key: "gram-si", names: ["g"], si: true, one: "gram" },
];

const isList = (v: unknown): v is Rule[] => Array.isArray(v);
const unitBlock = (k: string) => /\/units\//.test(k);

/** SRE's own maps for `locale` ("base" or "en"), with the physics units and the long function names. */
export function patchedMaps(locale: string): Maps {
  const src = (locale === "base" ? baseMaps : enMaps) as unknown as Maps;
  const out: Maps = {};
  // (Rule sets are objects; symbol, function and unit maps are lists of rules: those are copied, then patched.)
  for (const [k, rules] of Object.entries(src)) out[k] = isList(rules) ? rules.map((r) => ({ ...r })) : rules;
  // Our units take their symbols from SRE's (C was Celsius, F Fahrenheit, g a non-SI gram): °C and °F stay.
  const unitNames = new Set(PHYSICS_UNITS.flatMap((u) => u.names));
  for (const [k, rules] of Object.entries(out)) {
    if (!unitBlock(k) || !isList(rules)) continue;
    for (const r of rules) if (r.names) r.names = r.names.filter((n) => !unitNames.has(n));
  }
  if (locale === "base") {
    out["base/units/physics.min"] = [{ locale: "base" }, ...PHYSICS_UNITS.map((u) => ({ key: u.key, category: "other", si: u.si, names: u.names }))];
    return out;
  }
  // A unit with no entry in the base map (kΩ, MΩ) gets its key as its name: SRE fails on a unit with no name.
  const based = new Set(Object.entries(baseMaps as unknown as Maps).flatMap(([k, rules]) => (unitBlock(k) && isList(rules) ? rules.map((r) => r.key) : [])));
  for (const [k, rules] of Object.entries(out)) {
    if (!unitBlock(k) || !isList(rules)) continue;
    for (const r of rules) if (r.key && !r.names && !based.has(r.key)) r.names = [r.key];
  }
  out["en/units/physics.min"] = [{ locale: "en" }, ...PHYSICS_UNITS.map((u) => ({ key: u.key, mappings: { default: { default: u.one, ...(u.many ? { plural: u.many } : {}) } } }))];
  // ClearSpeak says "lim", "sup", "inf"; spoken, the words are clearer.
  const long: Record<string, string> = { lim: "limit", sup: "supremum", inf: "infimum", liminf: "limit inferior", limsup: "limit superior" };
  for (const rules of Object.values(out)) {
    if (!isList(rules)) continue;
    for (const r of rules) if (r.key && long[r.key] && r.mappings?.clearspeak) r.mappings = { ...r.mappings, clearspeak: { ...r.mappings.clearspeak, default: long[r.key]! } };
  }
  return out;
}

/** What every SRE setup gets (SRE reads the global `SREfeature`), its start-up included. */
export const SRE_FEATURES = {
  domain: "clearspeak",
  style: CLEARSPEAK_STYLE,
  locale: "en",
  modality: "speech",
  markup: "none",
  // SRE takes a JSON string or the parsed maps.
  custom: (locale: string) => Promise.resolve(patchedMaps(locale)),
};
(globalThis as { SREfeature?: unknown }).SREfeature = SRE_FEATURES;

// The server gives browser-shaped modules a `window` and a `document` (server/shims/globals.ts). SRE decides once,
// as it loads, whether it runs in a browser, and would take those stubs for a DOM (then every formula fails). So
// they are hidden while SRE loads — the next import, in server/speakMath.ts — and put back right after it.
const g = globalThis as Record<string, unknown>;
const hidden: [string, PropertyDescriptor][] = [];
for (const name of ["window", "document"]) {
  const d = Object.getOwnPropertyDescriptor(g, name);
  if (d && d.configurable) {
    hidden.push([name, d]);
    delete g[name];
  }
}
/** Put back the globals hidden for SRE's load (called by server/speakMath.ts once SRE is imported). */
export function restoreBrowserGlobals(): void {
  for (const [name, d] of hidden.splice(0)) Object.defineProperty(g, name, d);
}
