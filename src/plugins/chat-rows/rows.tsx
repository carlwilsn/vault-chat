// The chat transcript's rows, as renderers (src/chatRows.ts): the app's own renderers for each row kind, moved here
// unchanged from ChatPane.tsx, registered as the built-in layer, and the row dispatcher (MessageBubble, Row) that draws
// each row with the renderer the registry names for its kind. A plugin's renderer (a vault plugin's
// api.host.chat.row(kind, render)) draws into a plain block element; a renderer that throws falls back, for that row
// only, to the built-in and then to the plain fallback row, so the chat always stands.
import { ChangeLine } from "../../ChangeLine";
import { Component, memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef, type ComponentType, type ReactNode } from "react";
import { ChevronDown, Wrench, Mic, AlertCircle, Info, Loader2, FileText } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Markdown } from "../../Markdown";
import { readChatImage } from "../../chatImage";
import { InlineHtmlFrame } from "../../InlineHtmlFrame";
import { VideoPlayer } from "../../VideoPlayer";
import { isHtmlSrc } from "../../inlineHtml";
import { InlineWebPage } from "../../InlineWebPage";
import { soloWebImages } from "../../inlineWeb";
import { localPathFromUrl } from "../../mdPipeline";
import { planDone } from "../../planPlace";
import { splitFilesLine } from "../../filesLine";
import { dispatchChatAction } from "../../sync";
import { COMPACTION_DIVIDER_TEXT, isCompactionDivider, dividerSummary } from "../../chatContext";
import { useStore, type ChatMessage, type TodoItem } from "../../store";
import { cn } from "../../lib/utils";
import { boxLinkFor, fetchBoxFile } from "../../boxChat";
import { AskOptions, ReplyCost, Subagents, Thought, isLegacySubagentRecord, withoutOptionList, type SubagentRec } from "../../chatExtras";
import { chainFor, kindOf, noteRowFailure, registerBuiltin, registerRowOptions, rowChain, rowOption, rowsVersion, subscribeRows, toolChain, type RowData, type RowRenderer } from "../../chatRows";
import { inlineHtmlOptionDefs, planOptionDefs, type InlinePlacement, type PlanDone, type PlanPlacement } from "./options";

// Markdown (math, tables, code, safe HTML, URLs) renders through the shared
// pipeline (Markdown.tsx / mdPipeline.ts): data:image URLs and Windows
// absolute paths pass its URL check, so ChatImage can load them.

// Render images in chat bubbles the same way MarkdownView does for
// vault files: data:/blob:/http(s) URLs go straight to the DOM; file
// paths get read off disk and turned into blob URLs so the Tauri
// webview can actually display them (file:// is blocked). Relative
// paths are resolved against the active vault root, so an agent reply
// like `![chart](./assets/forecast.png)` or `![cap](.vault-chat/
// captures/foo.png)` renders. Without this override, react-markdown
// handed the raw src to the DOM and the image silently failed to load.
export const ChatImage = memo(function ChatImage({
  src,
  alt,
  ...rest
}: ComponentPropsWithoutRef<"img">) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const convId = useStore((s) => s.activeConversationId);
  const mediaKey = JSON.stringify([src, vaultPath, convId]);
  const [media, setMedia] = useState<{ key: string; url: string } | null>(null);
  const url = media?.key === mediaKey ? media.url : null;
  const [failedPath, setFailedPath] = useState<string | null>(null);

  // Reuse the retained video-playback-1030 fix: a mount, not a file-index
  // snapshot, owns this URL. Still re-read bytes so replacements are visible.
  const loaded = useRef<{ path: string; bytes: Uint8Array; url: string } | null>(null);
  useEffect(() => {
    setMedia(null);
    setFailedPath(null);
    return () => {
      if (loaded.current) URL.revokeObjectURL(loaded.current.url);
      loaded.current = null;
    };
  }, [mediaKey]);

  useEffect(() => {
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setMedia({ key: mediaKey, url: src });
      return;
    }
    const cleaned = localPathFromUrl(src);
    const isAbs = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned);
    if (!isAbs && !vaultPath) return;
    const sep = (vaultPath ?? "").includes("\\") ? "\\" : "/";
    const primary = isAbs
      ? cleaned
      : `${vaultPath}${sep}${cleaned.replace(/^\.\/+/, "")}`;

    let cancelled = false;
    const show = (path: string, bytes: ArrayLike<number>) => {
      const data = new Uint8Array(bytes);
      const prev = loaded.current;
      if (prev?.path === path && prev.bytes.length === data.length && prev.bytes.every((b, i) => b === data[i])) return;
      const dot = path.lastIndexOf(".");
      const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
      const mime = videoMime(path) ??
        (ext === "svg"
          ? "image/svg+xml"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "png"
              ? "image/png"
              : ext === "gif"
                ? "image/gif"
                : ext === "webp"
                  ? "image/webp"
                  : ext === "bmp"
                    ? "image/bmp"
                    : ext === "ico"
                      ? "image/x-icon"
                      : `image/${ext || "png"}`);
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      loaded.current = { path, bytes: data, url };
      setFailedPath(null);
      setMedia({ key: mediaKey, url });
      if (prev) URL.revokeObjectURL(prev.url);
    };
    (async () => {
      // A box fetch can fail for a moment (link not up yet, 10 s timeout, conversation not
      // indexed yet): retry a few times before showing "image not found" for good.
      let image = null;
      for (let attempt = 0; attempt < 4 && !image; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, [0, 1000, 3000, 8000][attempt]));
        if (cancelled) return;
        image = await readChatImage(cleaned, vaultPath, files, {
          local: (path) => invoke<number[]>("read_binary_file", { path }),
          box: async () => {
            const link = await boxLinkFor(vaultPath);
            // No local or viewer-root fallback once this is a box conversation.
            // The existing backend log is the authority for convId's asset root.
            return link ? (path) => convId ? fetchBoxFile(link, path, convId) : Promise.resolve(null) : null;
          },
        });
      }
      if (cancelled) return;
      if (image) {
        show(image.path, image.bytes);
        return;
      }
      if (!cancelled) {
        console.warn("[chat] image load failed:", primary);
        if (loaded.current) URL.revokeObjectURL(loaded.current.url);
        loaded.current = null;
        setMedia(null);
        setFailedPath(primary);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, vaultPath, files, convId, mediaKey]);

  if (!url) {
    // Honest fallback: make it obvious this is a failed image load, not
    // intentional bracket text. The old `[alt]` rendering was visually
    // indistinguishable from a literal markdown footnote/reference and
    // gave no signal that anything went wrong.
    return (
      <span className="text-muted-foreground italic text-[11.5px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block">
        ⚠ image not found: {failedPath ?? src}
        {alt ? ` (${alt})` : ""}
      </span>
    );
  }
  // No autoplay: Carl's own Play starts video AND audio. The app's player, not the webview's controls.
  if (isVideoSrc(src)) return <VideoPlayer src={url ?? ""} title={alt} dataEl="chat-video" />;
  return <img src={url} alt={alt} {...rest} />;
});

const VIDEO_EXT: Record<string, string> = { webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" };
function videoMime(src: string | undefined): string | null {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src ?? "");
  return m ? (VIDEO_EXT[m[1]!.toLowerCase()] ?? null) : null;
}
const isVideoSrc = (src: string | undefined) => !!videoMime(src);

/** A vault .html in image syntax renders live in the bubble (InlineHtmlFrame); everything else is ChatImage. */
function ChatMedia(props: ComponentPropsWithoutRef<"img">) {
  const { src } = props;
  if (typeof src === "string" && isHtmlSrc(src) && !/^(https?|data|blob):/i.test(src))
    return <InlineHtmlPart src={src} alt={props.alt} sizeHint={props.title} />;
  return <ChatImage {...props} />;
}

/** A paragraph holding a public web page on a line of its own (`![label](https://…)`, src/inlineWeb.ts): the page shows
 *  live there (InlineWebPage); the rest of the paragraph stays text around it. */
function ChatParagraph({ node, children, ...rest }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) {
  const solo = soloWebImages(node as Parameters<typeof soloWebImages>[0]);
  const kids = Array.isArray(children) ? children : [children];
  const hast = ((node as { children?: unknown[] } | undefined)?.children ?? []) as { properties?: Record<string, unknown> }[];
  if (!solo.length || kids.length !== hast.length) return <p {...rest}>{children}</p>;
  const out: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  const flush = () => {
    if (run.some((k) => !(typeof k === "string" && !k.trim()))) out.push(<p key={`p${out.length}`} {...rest}>{run}</p>);
    run = [];
  };
  kids.forEach((k, i) => {
    if (!solo.includes(i)) { run.push(k); return; }
    flush();
    const pr = hast[i]?.properties ?? {};
    out.push(<InlineWebPage key={`w${i}`} src={String(pr.src)} alt={typeof pr.alt === "string" ? pr.alt : undefined} sizeHint={typeof pr.title === "string" ? pr.title : undefined} />);
  });
  flush();
  return <>{out}</>;
}

export const chatComponents = { img: ChatMedia, p: ChatParagraph } as const;

// Strip the trailing "[attached: ...]" footer that ChatPane appends to
// user turns so the agent sees resolved @-ref paths. The footer is
// meant for the model, not the user's own bubble.
function stripAttachedFooter(src: string): string {
  return src.replace(/\n*\[attached:[^\]]*\]\s*$/, "");
}


/**
 * A message sent while the agent works, not yet read by it: on hover, "Send now" (cut the agent's
 * current step; it answers this next), Edit (back into the composer) and Cancel.
 */
function WaitingActions({ message }: { message: ChatMessage }) {
  const convId = useStore((s) => s.activeConversationId);
  if (!convId || !message.mid) return null;
  const id = message.mid;
  const btn = "h-5 px-1.5 rounded text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-accent/60";
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity" data-el="waiting-actions">
      <button className={btn} onClick={() => dispatchChatAction({ kind: "sendNow", convId, id })} title="Interrupt the agent's current step and send this now" data-el="send-now">
        Send now
      </button>
      <button
        className={btn}
        onClick={() => {
          dispatchChatAction({ kind: "unqueue", convId, id });
          window.dispatchEvent(new CustomEvent("vc-composer-insert", { detail: splitFilesLine(stripAttachedFooter(message.content)).text }));
        }}
        title="Take it back into the composer"
        data-el="waiting-edit"
      >
        Edit
      </button>
      <button className={btn} onClick={() => dispatchChatAction({ kind: "unqueue", convId, id })} title="Take it back (not sent)" data-el="waiting-cancel">
        Cancel
      </button>
    </div>
  );
}

/** What every row renderer of a message is given (MessageBubble's props). */
export type RowProps = {
  message: ChatMessage;
  /** The message's index in the chat (the transcript passes it: the agent's scrollTo finds the row by it). */
  index?: number;
  /** Try again on a turn that ended on a failed request (its line's `retry`). */
  onRetry?: () => void;
  /** A voice line right after another: the same voice turn (no marker of its own). */
  voiceCont?: boolean;
  /** AskUser options on this reply: still the open fork, and the answer given. */
  askLive?: boolean;
  askChosen?: string;
  onAsk?: (answer: string) => void;
  /** The subagents this reply's `subagent` call spawned (inline option). */
  spawns?: SubagentRec[];
  onOpenSubagent?: (id: string) => void;
  openableThreadIds?: readonly string[];
  onSubagent?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
};

/** The row's own attribute (on its outer element): its index, for the agent's scrollTo. */
const rowAttr = (index: number | undefined) => (index === undefined ? {} : { "data-row": index });
/** A part of a row (a tool call, an inline page) or the plan card under a reply: never the row's own attribute. */
const partAttr = (data: RowData) => (data.kind === "plan" || data.kind === "inline-html" || data.kind.startsWith("tool-call") ? {} : rowAttr(data.index));

/** One row of the transcript: its kind's renderer, from the registry (src/chatRows.ts). */
export const MessageBubble = memo(function MessageBubble(props: RowProps) {
  const kind = kindOf(props.message, isCompactionDivider as (m: unknown) => boolean);
  return <Row kind={kind} props={props} data={{ kind, index: props.index, message: props.message }} />;
});

function CompactionRow({ message, index }: RowProps) {
  return <CompactionDivider message={message} index={index} />;
}

// A job's or a background task's end is a system line of its own kind (before the generic notice).
// A finished one says nothing here (the agent's reply carries the result); a failed or stopped one is one quiet line.
function JobEndRow({ message, index }: RowProps) {
  const job = message.job!;
  return job.failed || job.status === "stopped" ? <JobRow job={job} index={index} /> : null;
}

// Work under way that is not a reply (the box summarizing the earlier conversation): the working spinner and its time.
function WorkingRow({ message, index }: RowProps) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground min-w-0" data-el="notice" data-working="1" {...rowAttr(index)}>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="break-words min-w-0">{message.content}</span>
      {message.working?.since ? <Elapsed since={message.working.since} /> : null}
    </div>
  );
}

// A quiet notice (voice ended, an error): left, in the tool rows' small muted type.
function NoticeRow({ message, index, onRetry }: RowProps) {
  return (
    <div className={cn("flex items-start gap-1.5 text-[11px] leading-snug", message.failed ? "text-destructive/90" : "text-muted-foreground")} data-el="notice" {...rowAttr(index)}>
      {message.failed ? <AlertCircle className="h-3 w-3 mt-px shrink-0" /> : <Info className="h-3 w-3 mt-px shrink-0" />}
      <span className="break-words min-w-0">
        {message.content}
        {message.change?.offer && <ChangeLine change={message.change} />}
      </span>
      {message.retry && onRetry && (
        <button type="button" data-el="retry" onClick={onRetry} className="shrink-0 ml-1 underline underline-offset-2 hover:text-foreground">
          Try again
        </button>
      )}
    </div>
  );
}

function VoiceAskMessageRow({ message, index }: RowProps) {
  return <VoiceAskRow ask={message.voiceAsk!} index={index} />;
}

function VoiceMessageRow({ message, voiceCont = false, index }: RowProps) {
  return <VoiceLine message={message} cont={voiceCont} index={index} />;
}

function UserBubble({ message, index }: RowProps) {
  const userText = splitFilesLine(stripAttachedFooter(message.display ?? message.content));
  return (
    <div className="flex flex-col gap-1.5 items-end group/msg" data-message-id={message.mid} {...(message.waiting ? { "data-el": "waiting-message" } : {})} {...rowAttr(index)}>
        <div className={cn("max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden prose-user", message.waiting && "opacity-60")}>
          {/* Persisted feed entries may carry only a capture path, not inline pixels.
              Use the same scoped local/box loader as markdown images. */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1.5">
              {message.attachments.map((a, i) => {
                const name = a.sourcePath?.split("/").pop();
                return (
                  <div key={i} className="flex flex-col items-start gap-0.5">
                    <ChatImage
                      src={a.imageDataUrl || a.capturedFilePath}
                      alt={`captured ${i + 1}`}
                      className="max-h-[160px] rounded"
                    />
                    {name && (
                      <span className="text-[9.5px] opacity-80 font-mono">
                        {name}
                        {a.sourceAnchor ? ` · ${a.sourceAnchor}` : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {userText.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5" data-el="message-files">
              {userText.files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 text-[11px]">
                  <FileText className="h-3 w-3 shrink-0 opacity-80" />
                  <span className="max-w-[240px] truncate">{f}</span>
                </span>
              ))}
            </div>
          )}
          {userText.text.trim() && <Markdown source={userText.text} profile="user" components={chatComponents} />}
        </div>
        {message.waiting && (
          <div className="flex items-center gap-1.5 -mt-0.5">
            <WaitingActions message={message} />
            <span className="text-[10.5px] text-muted-foreground" data-el="waiting-mark" title="Sent — the agent reads it at its next step">
              queued
            </span>
          </div>
        )}
    </div>
  );
}

function AssistantBubble({ message, index, askLive = false, askChosen = "", onAsk, spawns, onOpenSubagent, openableThreadIds, onSubagent }: RowProps) {
  const calls = (message.toolCalls ?? []).filter((t) => !isLegacySubagentRecord(t));
  return (
    <div className="flex flex-col gap-1.5" data-message-id={message.mid} {...(message.waiting ? { "data-el": "waiting-message" } : {})} {...rowAttr(index)}>
        <div className="w-full space-y-2">
          {message.thinking && <Thought text={message.thinking} />}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2" data-el="shown-images">
              {message.attachments.map((a, i) => (
                <ChatImage key={i} src={a.imageDataUrl || a.capturedFilePath} alt={a.sourcePath?.split("/").pop() ?? `image ${i + 1}`} className="max-h-[260px] max-w-full rounded-lg border border-border/60" />
              ))}
            </div>
          )}
          <div className="prose-chat text-foreground/95">
            <Markdown
              source={message.askOptions?.length ? withoutOptionList(message.content, message.askOptions) : (message.display ?? message.content)}
              profile="chat"
              components={chatComponents}
            />
          </div>
          {onAsk && message.askOptions && message.askOptions.length > 0 && <AskOptions options={message.askOptions} live={askLive} chosen={askChosen} onPick={onAsk} />}
          {calls.length > 0 && (
            <details className="group" data-el="tool-calls">
              <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                <Wrench className="h-3 w-3" />
                <span>{calls.length} tool call{calls.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="mt-2 space-y-2 pl-4 border-l border-border">
                {calls.map((t, j) => (
                  <ToolPart key={j} tool={t} index={index} message={message} />
                ))}
              </div>
            </details>
          )}
          {spawns && spawns.length > 0 && <Subagents list={spawns} variant="inline" onControl={onSubagent} onOpen={onOpenSubagent} openableThreadIds={openableThreadIds} />}
          <ReplyCost m={message} />
        </div>
    </div>
  );
}

type ToolCallProps = { tool: NonNullable<ChatMessage["toolCalls"]>[number] };
/** One tool call inside a reply's "N tool calls". */
function ToolCallRow({ tool: t }: ToolCallProps) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-primary">{t.name}</div>
      <pre className="text-[10.5px] font-mono bg-muted/60 border border-border/40 rounded p-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-all">
        {JSON.stringify(t.input, null, 2)}
      </pre>
      {t.result && (
        <pre className="text-[10.5px] font-mono bg-muted/30 border border-border/40 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
          {t.result.length > 1200 ? `${t.result.slice(0, 1200)}…` : t.result}
        </pre>
      )}
    </div>
  );
}

/** One tool call: its renderer chain for this call (a plugin's `when` may step aside for it). */
function ToolPart({ tool, index, message }: { tool: ToolCallProps["tool"]; index?: number; message: ChatMessage }) {
  const data: RowData = { kind: "tool-call", index, message, tool };
  return <Part chain={chainFor(toolChain(tool.name), data)} props={{ tool }} data={data} />;
}

// The plan: where it shows is the plan renderer's own choice (its `placement` option, settable live through
// app/chat-rows: src/plugins/chat-rows/options.ts), not the chat pane's. The pane offers two places, under the reply
// that wrote it (PlanRow) and above the composer (PinnedPlan); each draws only when the plan is placed there.

/** The plan card under the reply that wrote it (placement "inline"). */
export function PlanRow({ todos, index }: { todos: TodoItem[]; index?: number }) {
  useSyncExternalStore(subscribeRows, rowsVersion, rowsVersion);
  if (rowOption<PlanPlacement>("plan", "placement") !== "inline") return null;
  return <Row kind="plan" props={{ todos, index }} data={{ kind: "plan", index, todos, placement: "inline" }} />;
}

/** The current plan above the composer (placement "pinned"): while the agent works or a step is left. */
export function PinnedPlan({ todos, busy }: { todos: TodoItem[]; busy: boolean }) {
  useSyncExternalStore(subscribeRows, rowsVersion, rowsVersion);
  if (rowOption<PlanPlacement>("plan", "placement") !== "pinned" || todos.length === 0) return null;
  if (!busy && !todos.some((t) => t.status !== "completed")) return null;
  return (
    <div className="mb-1.5 max-h-40 overflow-auto" data-el="todos-pinned">
      <Row kind="plan" props={{ todos }} data={{ kind: "plan", todos, placement: "pinned" }} />
    </div>
  );
}

function PlanCardRow({ todos }: { todos: TodoItem[] }) {
  return <AgentTodoList todos={todos} done={rowOption<PlanDone>("plan", "done")} />;
}

// ---------------------------------------------------------------- the dispatcher

/** The plain row: whatever has no renderer (or whose renderers all threw) still shows its text. */
function FallbackRow({ data }: { data: RowData }) {
  const m = (data.message ?? {}) as Partial<ChatMessage>;
  const t = data.tool as { name?: string } | undefined;
  const tools = data.tools as { name?: string; result?: string }[] | undefined;
  const live = tools ? tools.find((x) => !x.result) ?? tools[tools.length - 1] : undefined;
  const text =
    data.kind === "plan" ? `Plan · ${(data.todos as unknown[] | undefined)?.length ?? 0} steps`
    : t ? String(t.name ?? "tool call")
    : data.src ? String(data.alt || data.src)
    : typeof data.text === "string" ? data.text
    : live ? `${live.name ?? "tool"}${live.result ? " ✓" : " …"}`
    : data.kind === "thinking-indicator" ? "Working…"
    : String(m.display ?? m.content ?? "");
  if (!text.trim()) return null;
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground whitespace-pre-wrap break-words" data-el="row-fallback" data-kind={data.kind} {...partAttr(data)}>
      {m.role === "user" ? "You: " : ""}
      {text}
    </div>
  );
}

/** A plugin's renderer: a plain block element it draws into (redrawn when the row's data changes). A throw is the row's. */
function DomRow({ renderer, data }: { renderer: RowRenderer; data: RowData }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !renderer.dom) return;
    let undo: void | (() => void);
    try {
      undo = renderer.dom(el, data);
    } catch (e) {
      setErr(e ?? new Error("the renderer threw"));
    }
    return () => {
      try {
        if (typeof undo === "function") undo();
      } catch {
        /* its cleanup's problem */
      }
      el.replaceChildren();
    };
  }, [renderer, data]);
  if (err) throw err;
  return <div ref={ref} data-el="row-plugin" data-kind={data.kind} data-renderer={renderer.id} {...partAttr(data)} />;
}

type ChainProps = { chain: readonly RowRenderer[]; props: object; data: RowData };
/** Draws the chain's first renderer; one that throws hands the row to the next, the last to the fallback row. */
class RowBoundary extends Component<ChainProps, { level: number; chain: readonly RowRenderer[]; data: RowData }> {
  state = { level: 0, chain: this.props.chain, data: this.props.data };
  static getDerivedStateFromProps(p: ChainProps, s: { level: number; chain: readonly RowRenderer[]; data: RowData }) {
    // Another renderer or another row: start again from the best one.
    return p.chain !== s.chain || p.data.message !== s.data.message || p.data.tool !== s.data.tool || p.data.todos !== s.data.todos ? { level: 0, chain: p.chain, data: p.data } : null;
  }
  static getDerivedStateFromError() {
    return null;
  }
  componentDidCatch(err: unknown) {
    const r = this.props.chain[this.state.level];
    if (r) noteRowFailure(r.id, err);
    console.warn(`[chat] row renderer ${r?.id ?? "fallback"} failed (${this.props.data.kind}):`, err);
    this.setState((s) => ({ level: s.level + 1 }));
  }
  render(): ReactNode {
    return drawRenderer(this.props.chain[this.state.level], this.props.props, this.props.data);
  }
}

function drawRenderer(r: RowRenderer | undefined, props: object, data: RowData): ReactNode {
  if (!r) return <FallbackRow data={data} />;
  if (r.dom) return <DomRow renderer={r} data={data} />;
  const C = r.component as ComponentType<object>;
  return <C {...props} />;
}

/** A row of the transcript (or of the live tail, ./tail.tsx): follows the registry live (a plugin's renderer on or off redraws it). */
export function Row({ kind, props, data }: { kind: string; props: object; data: RowData }) {
  useSyncExternalStore(subscribeRows, rowsVersion, rowsVersion);
  return <RowBoundary chain={chainFor(rowChain(kind), data)} props={props} data={data} />;
}

/** A part of a row (a tool call): the built-in draws as before (the row's own boundary covers it); a plugin's renderer
 *  gets a boundary of its own, so its throw falls back to the built-in for that part only. */
function Part({ chain, props, data }: ChainProps) {
  if (chain.length === 1 && chain[0]!.builtin) return <>{drawRenderer(chain[0], props, data)}</>;
  return <RowBoundary chain={chain} props={props} data={data} />;
}

/** A vault .html shown inline (in image syntax): its renderer, live. */
function InlineHtmlPart(props: { src: string; alt?: string; sizeHint?: string }) {
  useSyncExternalStore(subscribeRows, rowsVersion, rowsVersion);
  const data: RowData = { kind: "inline-html", src: props.src, alt: props.alt };
  return <Part chain={chainFor(rowChain("inline-html"), data)} props={props} data={data} />;
}
/** The app's own inline page. Its options (src/plugins/chat-rows/options.ts) decide: live in the chat or only a button
 *  that opens it in the viewer, whether it folds to that button while the viewer shows it, its frame's size when the
 *  page asks none, and the "Open in viewer" button on the frame. */
function InlineHtmlRow({ src, alt, sizeHint }: { src: string; alt?: string; sizeHint?: string }) {
  return (
    <InlineHtmlFrame
      src={src}
      alt={alt}
      sizeHint={sizeHint}
      placement={rowOption<InlinePlacement>("inline-html", "placement")}
      foldInViewer={rowOption<boolean>("inline-html", "foldInViewer")}
      size={rowOption<string>("inline-html", "size")}
      viewerButton={rowOption<boolean>("inline-html", "viewerButton")}
    />
  );
}


// A line said on a voice call looks like the thread around it (Carl, 2026-10-21: the separate "YOU" voice style
// looked broken next to the bubbles): his spoken words are his bubble, the voice's replies are agent text, each
// with a tiny mic so a spoken line is still told apart from a typed one. The mic sits in a box exactly one text
// line tall (13px type, leading-relaxed = 1.625em), centred on the first line; the text keeps at least that
// height, so an empty or "…" line, or one still streaming, never shifts it.
function VoiceLine({ message, cont, index }: { message: ChatMessage; cont: boolean; index?: number }) {
  const isUser = message.role === "user";
  const mic = (
    <span className="flex h-[1.625em] w-2.5 shrink-0 items-center" data-el="voice-mic">
      <Mic className={cn("block h-2.5 w-2.5", isUser ? "opacity-70" : "text-muted-foreground/70")} aria-label="said aloud" />
    </span>
  );
  if (isUser)
    return (
      <div className={cn("flex flex-col items-end", cont && "-mt-1")} data-el="voice-line" data-role="user" {...rowAttr(index)}>
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden prose-user flex items-start gap-1.5">
          {mic}
          <div className="min-w-0 min-h-[1.625em]">
            <Markdown source={message.display ?? message.content} profile="user" components={chatComponents} />
          </div>
        </div>
      </div>
    );
  return (
    <div className={cn("w-full flex items-start gap-1.5 text-[13px] leading-relaxed", cont && "-mt-1")} data-el="voice-line" data-role={message.role} {...rowAttr(index)}>
      {mic}
      <div className="min-w-0 flex-1 min-h-[1.625em]">
        <Markdown source={message.display ?? message.content} profile="chat" components={chatComponents} />
      </div>
    </div>
  );
}

// The agent's work on something Carl said on a call (server/voice.ts Ask), shown as its own — one agent (Carl,
// 2026-10-22: "we are all one agent"): working (a spinner, the time it has run), then the tools it ran and what
// came back, collapsed like a tool row; the spoken reply is the line after it. Never a "voice asked" row.
function VoiceAskRow({ ask, index }: { ask: NonNullable<ChatMessage["voiceAsk"]>; index?: number }) {
  const line = ask.result.replace(/\s+/g, " ").trim();
  // Handed over and still working: said at once (Carl, 2026-10-22: no feedback until the result read as nothing
  // happening) — a spinner, what was asked, and how long it has run; the result replaces it in place.
  if (ask.running) {
    return (
      <div data-el="voice-ask" data-running="1" {...rowAttr(index)} className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="shrink-0">Working</span>
        <span className="truncate opacity-80">· {ask.request}</span>
        {ask.startedAt ? <Elapsed since={ask.startedAt} /> : null}
      </div>
    );
  }
  return (
    <details className="group" data-el="voice-ask" {...rowAttr(index)}>
      <summary className={cn("flex items-center gap-1.5 text-[11px] cursor-pointer hover:text-foreground list-none select-none min-w-0", ask.failed ? "text-destructive/90" : "text-muted-foreground")}>
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{ask.failed ? "Couldn't finish" : `Worked${ask.ms ? ` ${workedFor(ask.ms)}` : ""}`}</span>
        <span className="truncate opacity-80">· {ask.failed ? line : ask.tools?.length ? ask.tools.join(", ") : ask.request}</span>
      </summary>
      <div className="mt-2 space-y-1.5 pl-4 border-l border-border text-[11.5px]">
        <div className="text-muted-foreground">
          <span className="font-medium">You said:</span> {ask.request}
        </div>
        <div className="prose-chat text-foreground/90">
          <Markdown source={ask.result || "(nothing came back)"} profile="chat" components={chatComponents} />
        </div>
      </div>
    </details>
  );
}

// A background job that ended: one quiet row like a tool row ("Job finished · safety copies"), red when
// it failed; its last output lines when opened. (The agent gets the whole wake: exit code and output.)
function JobRow({ job, index }: { job: NonNullable<ChatMessage["job"]>; index?: number }) {
  // A background task's end: the row only (the agent's next message tells the result).
  if (job.task)
    return (
      <div data-el="task-end" {...rowAttr(index)} data-failed={job.failed ? "1" : "0"} className={cn("flex items-center gap-1.5 text-[11px] min-w-0", job.failed ? "text-destructive/90" : "text-muted-foreground")}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", job.failed ? "bg-destructive/80" : job.status === "finished" ? "bg-emerald-600" : "bg-muted-foreground/50")} />
        <span className="shrink-0">Background task {job.status}</span>
        <span className="truncate opacity-80">· {job.name}</span>
      </div>
    );
  return (
    <details className="group" data-el="job-end" {...rowAttr(index)}>
      <summary className={cn("flex items-center gap-1.5 text-[11px] cursor-pointer hover:text-foreground list-none select-none min-w-0", job.failed ? "text-destructive/90" : "text-muted-foreground")} title={job.id}>
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">Job {job.status}</span>
        <span className="truncate opacity-80">· {job.name}</span>
      </summary>
      <pre className="mt-2 pl-4 border-l border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-all font-mono">{job.output || "(no output)"}</pre>
    </details>
  );
}

/** "for 34 s", "for 2 min". */
const workedFor = (ms: number) => (ms < 90_000 ? `for ${Math.max(1, Math.round(ms / 1000))} s` : `for ${Math.round(ms / 60_000)} min`);

/** "0:12": how long something has run, ticking each second. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="shrink-0 tabular-nums opacity-70">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</span>;
}

const tokens = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
/** A compaction says it compacted, with the runtime's own sizes when it gave them ("182k → 14.2k tokens"); a roll-over
 *  reads as before. */
export function dividerLabel(m: ChatMessage): string {
  const c = m.compaction;
  if (!c || m.rollover) return COMPACTION_DIVIDER_TEXT;
  const sizes = c.before && c.after ? ` · ${tokens(c.before)} → ${tokens(c.after)} tokens` : c.before ? ` · from ${tokens(c.before)} tokens` : "";
  return `Conversation compacted${sizes}`;
}

// Where the earlier conversation was summarized: the quiet system-line divider,
// whose summary expands like a tool-call list.
function CompactionDivider({ message, index }: { message: ChatMessage; index?: number }) {
  // A compaction and the box's roll-over read the same: earlier, summarized here.
  return (
    <details className="group py-2" data-el="divider" {...rowAttr(index)}>
      <summary className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
        <div className="h-px w-8 bg-border" />
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        <span className="italic">{dividerLabel(message)}</span>
        <div className="h-px w-8 bg-border" />
      </summary>
      <div className="mt-2 pl-4 border-l border-border prose-chat text-[12px] text-muted-foreground">
        <Markdown source={dividerSummary(message)} profile="chat" components={chatComponents} />
      </div>
    </details>
  );
}

// Compact visual of the agent's current plan. Shows one row per todo,
// uses different glyphs/styles for pending / in_progress / completed.
// The agent maintains this list via the TodoWrite tool.
export function AgentTodoList({ todos, done: whenDone = "line" }: { todos: TodoItem[]; done?: PlanDone }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const [open, setOpen] = useState(false);
  // Every step done: one quiet line (click for the steps), or nothing, or the steps as they are (the plan's `done`).
  if (planDone(todos) && whenDone === "hidden") return null;
  if (planDone(todos) && !open && whenDone === "line") {
    return (
      <button
        onClick={() => setOpen(true)}
        data-el="todos-done"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        title="Show the plan's steps"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600/70" />
        Plan · {done}/{todos.length} done
      </button>
    );
  }
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1" data-el="todos">
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Plan</span>
        <span className="font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => {
          const label =
            t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return (
            <li
              key={i}
              className="flex items-start gap-2 text-[12px] leading-relaxed"
            >
              <span
                className={cn(
                  "mt-[5px] h-2 w-2 shrink-0 rounded-full",
                  t.status === "completed" && "bg-emerald-600",
                  t.status === "in_progress" && "bg-primary animate-pulse",
                  t.status === "pending" && "bg-muted-foreground/40",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  t.status === "completed" && "line-through text-muted-foreground",
                  t.status === "in_progress" && "text-foreground",
                  t.status === "pending" && "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


// ---------------------------------------------------------------- the built-in layer

registerBuiltin("divider", CompactionRow);
registerBuiltin("job", JobEndRow);
registerBuiltin("working", WorkingRow);
registerBuiltin("notice", NoticeRow);
registerBuiltin("voice-ask", VoiceAskMessageRow);
registerBuiltin("voice", VoiceMessageRow);
registerBuiltin("user", UserBubble);
registerBuiltin("assistant", AssistantBubble);
registerBuiltin("tool-call", ToolCallRow);
registerBuiltin("plan", PlanCardRow);
registerBuiltin("inline-html", InlineHtmlRow);
registerRowOptions("plan", planOptionDefs);
registerRowOptions("inline-html", inlineHtmlOptionDefs);
