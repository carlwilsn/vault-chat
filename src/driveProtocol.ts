// Messages between Carl's main window (src/driveHost.ts) and the agent's Drive window (src/driveRunner.ts). Native: Tauri
// events (the main window emits DRIVE_TO_DRIVE to the Drive window's label; the Drive window emits DRIVE_TO_MAIN to
// "main"). In a browser (the preview harness): postMessage between the page and its hidden Drive frame.
import type { Step, StepsResult } from "./driveSteps";
import type { TimingOptions, TimingResult } from "./driveTiming";

export const DRIVE_LABEL = "vc-drive";
export const DRIVE_TO_DRIVE = "vc-drive:to-drive";
export const DRIVE_TO_MAIN = "vc-drive:to-main";

export type DriveRequest =
  | { kind: "run"; reqId: string; mode: "steps"; steps: Step[] }
  | { kind: "run"; reqId: string; mode: "timing"; timing: Omit<TimingOptions, "signal"> }
  | { kind: "abort"; reqId: string; reason: string };

export type DriveReply =
  | { kind: "ready"; ok: boolean; error?: string; note?: string; readyMs: number }
  | { kind: "result"; reqId: string; steps?: StepsResult; timing?: TimingResult; error?: string; aborted?: string };

export const isDriveMsg = (d: unknown): d is { __vcDrive: true; msg: DriveRequest | DriveReply } => !!d && typeof d === "object" && (d as { __vcDrive?: unknown }).__vcDrive === true && !!(d as { msg?: unknown }).msg;
