// Live widgets inside notes (src/noteWidgets.ts): a long note with ```widget blocks in it (the sample widget,
// test/harness/fixtures/note-widgets/section-outline.js, twice; one that throws; one that is not there), and the same
// note without them (long-plain.md) to time opening a long note.
import type { BuildCtx, Scenario } from "./types";
import CORPUS_RAW from "../../test/harness/fixtures/markdown/corpus.md?raw";
import OUTLINE_JS from "../../test/harness/fixtures/note-widgets/section-outline.js?raw";
import BROKEN_JS from "../../test/harness/fixtures/note-widgets/broken.js?raw";

const corpus = CORPUS_RAW.replace(/\r\n/g, "\n").replace(/assets\/[^)\s]+|!\[\[[^\]]+\]\]/g, "");
/** About 60 KB of real markdown (math, tables, code, HTML): the corpus eight times, each under its own heading. */
const LONG = Array.from({ length: 8 }, (_, i) => `## Part ${i + 1}\n\n${corpus.replace(/^# .*$/m, "")}`).join("\n\n");
const widget = (src: string, text = "") => "```widget\n" + src + (text ? "\n" + text : "") + "\n```\n";

const WITH = `# Week 3: exam prep

${widget("widgets/section-outline.js", "This week's parts")}

## Exam prep

${widget("widgets/section-outline.js", "Before the exam")}

### Torque
### Angular momentum
### Rolling without slipping

${widget("widgets/broken.js")}

${widget("widgets/not-there.js")}

${LONG}

## The end

${widget("widgets/section-outline.js", "At the bottom: mounts only when scrolled to")}

### Last thing
`;

function build(ctx: BuildCtx): void {
  ctx.write("widgets/section-outline.js", OUTLINE_JS);
  ctx.write("widgets/broken.js", BROKEN_JS);
  ctx.write("long-widgets.md", WITH);
  ctx.write("long-plain.md", `# Week 3: exam prep\n\n${LONG}\n`);
  ctx.write("short.md", "# Short\n\nA short note.\n");
}

export const noteWidgetScenarios: Scenario[] = [
  {
    id: "note-widgets",
    title: "Notes — live widgets inside a long note",
    group: "Markdown",
    notes:
      "long-widgets.md: ```widget blocks mount in place (section-outline.js lists the headings of its section as a checklist kept as plugin.state, follows edits); one throws (an error card, the note stands); one is missing (a card). The last one mounts only when scrolled near. long-plain.md is the same note without widgets, for timing.",
    build,
    open: [{ file: "long-widgets.md", mode: "view" }, { sleep: 800 }],
    surfaces: ["desktop"],
  },
];
