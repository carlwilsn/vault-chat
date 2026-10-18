// ScrollTo's target matching (src/scrollTarget.ts), the same for HTML,
// markdown and PDF. Carl's session (v0.6.46): voice asked for
// "end-to-end-mdp-concepts" on a course-notes page and "the navigation timed
// out", twice. The page (a hash-routed single-file app, like
// fixtures/course-notes-mini.html) has headings without ids; a slug, a heading's
// text or a phrase must find them, and a miss must name the headings that exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchSection, nearestSections, norm, notFound, type Section } from "../../src/scrollTarget.ts";

// The sections the page's bridge lists for the fixture's first lecture: its headings, then the nav's links.
const page = readFileSync(new URL("./fixtures/course-notes-mini.html", import.meta.url), "utf8");
const lecture = /"01-mdps":\s*\{\s*title:\s*"([^"]+)",\s*sections:\s*\[([\s\S]*?)\]\s*,\s*\}/.exec(page)!;
const headings = [lecture[1]!, ...Array.from(lecture[2]!.matchAll(/\["([^"]+)",/g), (m) => m[1]!)];
const nav = Array.from(page.matchAll(/"(\d\d-[a-z-]+)":\s*\{\s*title:\s*"([^"]+)"/g), (m) => ({ id: `/${m[1]}`, text: m[2]!, link: true }));
const sections: Section[] = [...headings.map((text) => ({ text })), ...nav];

test("fixture: the page's sections are what the bridge would list", () => {
  assert.deepEqual(headings, ["MDPs, V and Q, value iteration", "TL;DR", "Making V optimal", "Why the first action is left free", "Q under a policy", "Gaps to fill"]);
  assert.equal(nav.length, 2);
});

test("a slug, a heading's text (any case), or part of it reaches the heading", () => {
  const at = (q: string) => (matchSection(sections, q) === null ? null : sections[matchSection(sections, q)!]!.text);
  assert.equal(at("making-v-optimal"), "Making V optimal");
  assert.equal(at("#making-v-optimal"), "Making V optimal");
  assert.equal(at("MAKING V OPTIMAL"), "Making V optimal");
  assert.equal(at("first action is left free"), "Why the first action is left free");
  assert.equal(at("q-under-a-policy-from-class"), "Q under a policy", "a heading inside a longer slug");
  // A heading and a nav link with the same name: the heading (no navigation).
  assert.equal(matchSection(sections, "MDPs, V and Q, value iteration"), 0);
  // Another lecture: its nav link (followed like a click).
  const pi = matchSection(sections, "policy iteration")!;
  assert.equal(sections[pi]!.link, true);
  assert.equal(sections[pi]!.id, "/02-policy-iteration");
  assert.equal(at("/02-policy-iteration"), "Policy iteration");
});

test("an exact id wins over text; a weak or tied guess moves nothing", () => {
  const s: Section[] = [{ id: "intro", text: "Background" }, { id: "background", text: "Introduction" }];
  assert.equal(matchSection(s, "background"), 1);
  assert.equal(matchSection(s, "Background"), 1, "the exact id first");
  assert.equal(matchSection(s, "kernel tricks"), null);
  assert.equal(matchSection(sections, "end-to-end-mdp-concepts"), null, "Carl's session: no such section on the page");
});

test("a miss names the nearest headings and how to retry", () => {
  const msg = notFound("end-to-end-mdp-concepts", "C:/vault/IEMS 469/course-notes.html", sections.filter((s) => !s.link));
  assert.match(msg, /^Error: "end-to-end-mdp-concepts" is not in course-notes\.html/);
  assert.match(msg, /Nearest headings: "MDPs, V and Q, value iteration"/, "the closest by shared words first");
  assert.match(msg, /All of them: .*"Making V optimal"/);
  assert.match(msg, /Call ScrollTo again/);
  assert.deepEqual(nearestSections([{ text: "Value iteration" }, { text: "Gaps" }], "value-iteration", 1), [{ text: "Value iteration" }]);
  assert.match(notFound("x", "a.html", []), /has no headings/);
  assert.equal(norm("#End-to-end: MDP concepts!"), "end to end mdp concepts");
});
