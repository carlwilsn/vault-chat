// The board inbox's format (board/INBOX.md) — one definition the box server
// (server/inbox.ts), the board app (board/) and the tests share.
//
// One send = one entry: `boards/.inbox/<id>/entry.json`, the files it needs
// beside it. Parts are ordered and each is addable on its own. The send is
// validated before anything is written (server/inbox.ts): a bad send is
// refused with its reasons and never reaches the inbox.
//
// An entry that a background make (BoardMake) is still producing exists from
// the start with `making` set and no parts, so nothing is invisible; a make
// that fails keeps the entry with `failed` set to the reason.

export const INBOX_DIR = ".inbox"; // under boards/
export const ENTRY_FILE = "entry.json";

/** Limits (INBOX.md). */
export const MAX_PDF_PAGES = 20;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_PARTS = 40;
export const MAX_MATH_CHARS = 20_000;
export const MAX_WIDGET_BYTES = 400 * 1024;
/** A widget is laid out once at this size (css px) unless the part says otherwise, then zoomed as a whole. */
export const WIDGET_LAYOUT = { w: 640, h: 480 };
/** The reading width math is typeset at (css px); the item scales from there. */
export const MATH_LAYOUT_W = 560;

export type PartKind = "pdf" | "math" | "image" | "widget";

type PartBase = {
  kind: PartKind;
  /** Shown in the inbox, e.g. "Problem 3". */
  label?: string;
  /** The width it lands at, in canvas units (the default view is 1000 wide). */
  width?: number;
};

export type PdfPart = PartBase & { kind: "pdf"; path: string; pages: number[] };
/** `html`: the typeset markdown (the server's rendering, KaTeX), a file beside the entry. */
export type MathPart = PartBase & { kind: "math"; markdown: string; html?: string; snapshot?: string };
/** `w`/`h`: the picture's own size (px; an SVG's from its viewBox). */
export type ImagePart = PartBase & { kind: "image"; path: string; alt: string; w?: number; h?: number };
/** `bundle`: the esbuild output beside the entry; `snapshot`: the PNG the headless check took; `layout`: its css px size. */
export type WidgetPart = PartBase & { kind: "widget"; path: string; alt: string; layout?: { w: number; h: number }; bundle?: string; snapshot?: string };
export type Part = PdfPart | MathPart | ImagePart | WidgetPart;

export type EntryStatus = "unread" | "read" | "added";

export type Entry = {
  id: string;
  title: string;
  note: string;
  from?: { conversation?: string };
  createdAt: number;
  parts: Part[];
  status: EntryStatus;
  /** Part index → where it went (the board and the items it became). */
  added?: Record<string, { board: string; items: string[]; at: number }>;
  /** A background make still producing this entry (BoardMake). `boot`: the server process running it. */
  making?: { request: string; startedAt: number; boot?: string };
  /** Why a make failed (after its own retries). */
  failed?: string;
  updatedAt?: number;
};

/** What the inbox list shows. */
export type EntrySummary = Pick<Entry, "id" | "title" | "note" | "createdAt" | "status" | "failed"> & {
  making: boolean;
  parts: { kind: PartKind; label?: string }[];
  added: number;
};

export function summarize(e: Entry): EntrySummary {
  return {
    id: e.id,
    title: e.title,
    note: e.note,
    createdAt: e.createdAt,
    status: e.status,
    ...(e.failed ? { failed: e.failed } : {}),
    making: !!e.making && !e.failed,
    parts: e.parts.map((p) => ({ kind: p.kind, ...(p.label ? { label: p.label } : {}) })),
    added: Object.keys(e.added ?? {}).length,
  };
}

/** An entry id: date-prefixed, lowercase, dashes. */
export const ENTRY_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const validEntryId = (s: unknown): s is string => typeof s === "string" && ENTRY_ID_RE.test(s);

/** "1-3,5" or [1, 2, 3] → a sorted list of distinct page numbers, or a reason. */
export function parsePages(input: unknown): number[] | string {
  const out: number[] = [];
  const push = (n: number) => {
    if (!Number.isInteger(n) || n < 1) throw new Error(`page ${n} is not a page number (pages are 1-based)`);
    out.push(n);
  };
  try {
    if (Array.isArray(input)) for (const v of input) typeof v === "string" ? parseSpec(v, push) : push(Number(v));
    else if (typeof input === "number") push(input);
    else if (typeof input === "string") parseSpec(input, push);
    else return "pages: a list of page numbers is required";
  } catch (e) {
    return (e as Error).message;
  }
  const pages = [...new Set(out)].sort((a, b) => a - b);
  if (!pages.length) return "pages: at least one page";
  if (pages.length > MAX_PDF_PAGES) return `pages: at most ${MAX_PDF_PAGES} per part (${pages.length} asked); send another part for the rest`;
  return pages;
}

function parseSpec(spec: string, push: (n: number) => void): void {
  for (const bit of spec.split(",")) {
    const t = bit.trim();
    if (!t) continue;
    const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a) throw new Error(`pages: ${t} runs backwards`);
      if (b - a > 200) throw new Error(`pages: ${t} is too long a range`);
      for (let n = a; n <= b; n++) push(n);
    } else if (/^\d+$/.test(t)) push(Number(t));
    else throw new Error(`pages: "${t}" is not a page or a range`);
  }
}

/** The vault-relative folder of an entry. */
export const entryDir = (id: string) => `boards/${INBOX_DIR}/${id}`;
