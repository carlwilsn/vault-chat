/** Wire DTOs only. Synced cards are display projections, never acceptance/health authority. */
export type ShipmentRelease = { id: string; version: string; revision: string; tag: string; publishedAt: string };
export type ShipmentRollback = { status: "requested" | "running" | "accepted" | "failed"; jobId?: string; error?: string };
export type ShipmentCard = {
  id: string; project: string; convId: string; title: string; acceptedAt: string; sourceRevision: string;
  status: "accepted" | "published" | "health-pending" | "shipped" | "rolling-back" | "rolled-back" | "needs-attention";
  release?: ShipmentRelease;
  health?: { status: "pending" | "healthy" | "failed"; reason: string; box: "pending" | "healthy" | "failed"; laptop: "pending" | "healthy" | "failed" };
  proof: { summaryUrl: string; mediaUrls: string[] };
  rollback?: ShipmentRollback;
};
export type ReleaseHealthChallenge = { releaseId: string; version: string; revision: string; challenge: string; issuedAt: number; expiresAt: number };
export type LaptopHealthReport = {
  releaseId: string; version: string; revision: string; challenge: string;
  tauri: boolean; frontendMounted: boolean; boxConnected: boolean; syncReady: boolean; updaterReady: boolean; error?: string;
};
