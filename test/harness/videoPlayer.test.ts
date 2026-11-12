// The app's own video player (src/VideoPlayer.tsx): the bar that replaces the
// browser's default controls, in the chat and in the viewer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoPlayer, videoTime, trackFraction } from "../../src/VideoPlayer.tsx";

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
