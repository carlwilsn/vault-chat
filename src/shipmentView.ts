import type { ShipmentCard } from "./shippingProtocol";

/** Server projections only: no client-computed shipping or health outcomes. */
export function shipmentsForThread(cards: ShipmentCard[], convId: string | null, project: string | null | undefined): ShipmentCard[] {
  if (!convId || !project) return [];
  return [...new Map(cards.filter((c) => c.convId === convId && c.project === project).map((c) => [c.id, c])).values()]
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
}

export function shipmentLabel(card: ShipmentCard): string {
  switch (card.status) {
    case "shipped": return "Shipped";
    case "accepted": return "Accepted · waiting for release";
    case "published": return "Published · checking release";
    case "health-pending": return "Published · waiting for health checks";
    case "rolling-back": return "Rolling back · shipping source revert";
    case "rolled-back": return "Rolled back";
    case "needs-attention": return "Release needs attention";
  }
}

export function rollbackPending(card: ShipmentCard): boolean {
  return card.status === "rolling-back" || card.status === "rolled-back" || !!card.rollback && card.rollback.status !== "failed";
}

/** Artifact links are server-issued HTTP(S) URLs, not arbitrary markdown/file/javascript links. */
export function shipmentArtifactUrl(raw: string, base: string): string | null {
  try {
    if (!raw || /[\\\u0000-\u0020]/.test(raw)) return null;
    const url = new URL(raw, base);
    const origin = new URL(base);
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin.origin || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
