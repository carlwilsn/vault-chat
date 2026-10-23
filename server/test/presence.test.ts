// Carl's input by surface (server/presence.ts): what keeps the self-updater waiting, and what does not.
import { describe, it, expect } from "vitest";
import { INPUT_BUSY_MS, inputSurface, noteInput, recentInput } from "../presence";

describe("presence", () => {
  it("names the surface of a request that is Carl's input, and nothing else", () => {
    expect(inputSurface("POST", "/api/v1/boards/board-oct-21")).toBe("board");
    expect(inputSurface("POST", "/api/v1/voice/transcript")).toBe("voice");
    expect(inputSurface("POST", "/api/v2/intent")).toBe("typed");
    expect(inputSurface("POST", "/api/v2/intent", "phone")).toBe("phone");
    expect(inputSurface("POST", "/answer", "phone")).toBe("phone");
    expect(inputSurface("POST", "/notes")).toBe("app");
    // Not input: reads, long polls, logs, telemetry, pushes, git, alerts.
    for (const [m, p] of [["GET", "/api/v1/boards/x"], ["GET", "/poll"], ["POST", "/api/v1/board/log"], ["POST", "/client-event"], ["POST", "/push/subscribe"], ["POST", "/api/v1/alert"], ["POST", "/api/v1/activity"], ["POST", "/vault.git/git-receive-pack"]] as const) {
      expect(inputSurface(m, p)).toBeNull();
    }
  });

  it("counts a surface for INPUT_BUSY_MS (10 minutes) after its last input", () => {
    const t = 1_000_000_000;
    noteInput("board", t);
    noteInput("phone", t - INPUT_BUSY_MS + 60_000);
    expect(recentInput(t + 1000)).toEqual({ board: 1, phone: 541 });
    expect(Object.keys(recentInput(t + 120_000))).toEqual(["board"]);
    expect(recentInput(t + INPUT_BUSY_MS)).toEqual({});
  });
});
