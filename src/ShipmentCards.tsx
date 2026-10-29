import { useRef, useState } from "react";
import type { ShipmentCard } from "./shippingProtocol";
import { rollbackPending, shipmentArtifactUrl, shipmentLabel } from "./shipmentView";
import "./shipmentCards.css";

export type ShipmentCardsProps = {
  cards: ShipmentCard[];
  artifactBase: string;
  onRollback: (id: string) => Promise<void>;
  onOpenProof?: (url: string) => Promise<void>;
};

export function ShipmentCards({ cards, ...props }: ShipmentCardsProps) {
  return <>{cards.map((card) => <Shipment key={card.id} card={card} {...props} />)}</>;
}

function Shipment({ card, artifactBase, onRollback, onOpenProof }: Omit<ShipmentCardsProps, "cards"> & { card: ShipmentCard }) {
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const pending = rollbackPending(card);
  const request = async () => {
    if (sending.current || requested || pending) return;
    sending.current = true;
    setRequested(true);
    setError("");
    try { await onRollback(card.id); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); setRequested(false); }
    finally { sending.current = false; }
  };
  const links = [card.proof.summaryUrl, ...card.proof.mediaUrls].map((raw, i) => ({ url: shipmentArtifactUrl(raw, artifactBase), label: i ? `Recording ${i}` : "Proof" })).filter((p) => p.url);
  return <section className="shipment-card" data-shipment-id={card.id} data-shipment-status={card.status} aria-label={`${shipmentLabel(card)}: ${card.title}`}>
    <strong>{shipmentLabel(card)}: {card.title}</strong>
    {card.health?.reason && card.status !== "shipped" && <p>{card.health.reason}</p>}
    <div className="shipment-actions">
      {links.map((p) => onOpenProof
        ? <button key={p.url} type="button" title={p.url!} onClick={() => { void onOpenProof(p.url!).catch((e) => setError(String(e))); }}>{p.label}</button>
        : <a key={p.url} href={p.url!} target="_blank" rel="noopener noreferrer">{p.label}</a>)}
      <button type="button" disabled={requested || pending} onClick={() => void request()} title="Revert this source change and ship the revert through the normal release pipeline">
        {card.status === "rolled-back" ? "Rolled back" : requested || pending ? "Roll back requested" : "Roll back"}
      </button>
    </div>
    {(error || card.rollback?.error) && <p className="shipment-error" role="alert">{error || card.rollback?.error}</p>}
  </section>;
}
