// The app's own video player (src/VideoPlayer.tsx): the bar that replaces the
// browser's default controls, in the chat and in the viewer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoPlayer, videoTime, trackFraction, videoBarHidden, idleWatch, VIDEO_IDLE_MS } from "../../src/VideoPlayer.tsx";

test("videoTime reads seconds as a clock, and an unknown duration as 0:00", () => {
  assert.equal(videoTime(0), "0:00");
  assert.equal(videoTime(9.9), "0:09");
  assert.equal(videoTime(75), "1:15");
  assert.equal(videoTime(3725), "1:02:05");
  assert.equal(videoTime(NaN), "0:00");
  assert.equal(videoTime(Infinity), "0:00");
  assert.equal(videoTime(-3), "0:00");
});

test("trackFraction is where the pointer is on the track, clamped to its ends", () => {
  assert.equal(trackFraction(150, 100, 200), 0.25);
  assert.equal(trackFraction(50, 100, 200), 0);
  assert.equal(trackFraction(900, 100, 200), 1);
  assert.equal(trackFraction(150, 100, 0), 0);
});

test("the player draws its own bar and never the browser's controls or autoplay", () => {
  const html = renderToStaticMarkup(createElement(VideoPlayer, { src: "/file?path=clip.webm", title: "the counter", dataEl: "chat-video" }));
  assert.match(html, /<video [^>]*src="\/file\?path=clip\.webm"/);
  assert.match(html, /<video [^>]*data-el="chat-video"/);
  assert.doesNotMatch(html, /<video [^>]*\bcontrols\b/);
  assert.doesNotMatch(html, /\bmuted=|\bauto[Pp]lay=/);
  for (const el of ["video-bar", "video-play", "video-seek", "video-mute", "video-full", "video-time"]) assert.match(html, new RegExp(`data-el="${el}"`));
  assert.match(html, /aria-label="Play"/);
  assert.match(html, /0:00 \/ 0:00/);
  // A chat video sits inside a markdown paragraph: phrasing content only.
  assert.doesNotMatch(html, /<div\b/);
});

test("the viewer's player fills its pane and takes more controls on its bar", () => {
  const html = renderToStaticMarkup(
    createElement(VideoPlayer, { src: "asset://v.mp4", fill: true, dataEl: "viewer-video", extra: createElement("button", { "data-el": "system-player" }, "x") }),
  );
  assert.match(html, /data-el="viewer-video"/);
  assert.match(html, /data-el="system-player"/);
  assert.match(html, /object-contain/);
});

test("the bar hides only while playing, idle, off the bar and not seeking", () => {
  const base = { playing: true, idle: true, overBar: false, dragging: false };
  assert.equal(videoBarHidden(base), true);
  assert.equal(videoBarHidden({ ...base, playing: false }), false, "paused: always shown");
  assert.equal(videoBarHidden({ ...base, idle: false }), false, "the mouse just moved");
  assert.equal(videoBarHidden({ ...base, overBar: true }), false, "the pointer rests on the bar");
  assert.equal(videoBarHidden({ ...base, dragging: true }), false, "seeking");
  assert.equal(VIDEO_IDLE_MS, 2500);
});

test("the idle clock goes idle after its time without a poke, and wakes on the next poke", () => {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const timers = {
    set: (fn: () => void, ms: number) => (pending.set(++id, { at: now + ms, fn }), id),
    clear: (t: unknown) => void pending.delete(t as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...pending]) if (t.at <= now) (pending.delete(k), t.fn());
  };
  const heard: boolean[] = [];
  const w = idleWatch(2500, (idle) => heard.push(idle), timers);
  w.poke();
  advance(2000);
  w.poke(); // a mouse move restarts the count
  advance(2000);
  assert.deepEqual(heard, []);
  advance(600);
  assert.deepEqual(heard, [true]);
  w.poke();
  assert.deepEqual(heard, [true, false]);
  w.poke();
  assert.deepEqual(heard, [true, false], "each change is heard once");
  w.sleep(); // the pointer left
  assert.deepEqual(heard, [true, false, true]);
  assert.equal(pending.size, 0);
  w.poke();
  w.stop();
  assert.equal(pending.size, 0);
});

test("the viewer's bar lies over the picture and starts shown; a chat's bar stays in the flow", () => {
  const viewer = renderToStaticMarkup(createElement(VideoPlayer, { src: "asset://v.mp4", fill: true, dataEl: "viewer-video" }));
  assert.match(viewer, /data-chrome="shown"/);
  assert.match(viewer, /data-el="video-bar"[^>]*class="[^"]*\babsolute\b[^"]*\bbottom-0\b/);
  assert.match(viewer, /<video [^>]*class="[^"]*cursor-pointer/);
  assert.doesNotMatch(viewer, /cursor-none/);
  assert.doesNotMatch(viewer, /data-el="video-bar"[^>]*class="[^"]*\bopacity-0\b/);
  const chat = renderToStaticMarkup(createElement(VideoPlayer, { src: "/file?path=clip.webm", dataEl: "chat-video" }));
  assert.doesNotMatch(chat, /data-chrome=/);
  assert.doesNotMatch(chat, /data-el="video-bar"[^>]*class="[^"]*\babsolute\b/);
});
