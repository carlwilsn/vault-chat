/** Authenticated native release-health telemetry; no chat card DTOs. */
export type ReleaseHealthChallenge = { releaseId: string; version: string; revision: string; challenge: string; issuedAt: number; expiresAt: number };
export type LaptopHealthReport = {
  releaseId: string; version: string; revision: string; challenge: string;
  tauri: boolean; frontendMounted: boolean; boxConnected: boolean; syncReady: boolean; updaterReady: boolean; error?: string;
};
