import { useEffect, useState } from "react";
import { boxLinkFor, fetchBoxFile } from "./boxChat";
import { Markdown } from "./Markdown";

/** Proof stays on the authenticated native box transport; no token in a browser URL. */
export function ShipmentProofViewer({ url, vault, onClose }: { url: string; vault: string | null; onClose: () => void }) {
  const [proof, setProof] = useState<{ text?: string; media?: string; kind?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    let blobUrl: string | undefined;
    setProof({});
    void (async () => {
      try {
        const link = await boxLinkFor(vault);
        if (!link) throw new Error("Box is not connected");
        const artifact = new URL(url);
        const path = artifact.searchParams.get("path") || "";
        if (artifact.origin !== new URL(link.url).origin || artifact.pathname !== "/file" || !/^\.vault-chat\/shipments\/proof\/[A-Za-z0-9_-]+\/(summary\.md|recording\.(mp4|webm|png))$/.test(path) || link.vault && artifact.searchParams.get("vault") !== link.vault) throw new Error("Invalid shipment proof link");
        const bytes = await fetchBoxFile(link, path);
        if (!bytes) throw new Error("Proof could not be read from the box");
        if (!live) return;
        if (path.endsWith(".md")) setProof({ text: new TextDecoder().decode(bytes) });
        else {
          const kind = path.endsWith(".png") ? "image/png" : path.endsWith(".webm") ? "video/webm" : "video/mp4";
          blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind }));
          setProof({ media: blobUrl, kind });
        }
      } catch (e) { if (live) setProof({ error: String(e instanceof Error ? e.message : e) }); }
    })();
    return () => { live = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [url, vault]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-5" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="Shipment proof" className="bg-background border border-border rounded-xl p-4 max-w-4xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-3"><strong>Proof</strong><button type="button" onClick={onClose} autoFocus>Close</button></div>
      {proof.error ? <p role="alert">{proof.error}</p> : proof.text !== undefined ? <Markdown source={proof.text} profile="note" /> : proof.media ? proof.kind === "image/png" ? <img src={proof.media} alt="Host-recorded proof" className="max-w-full" /> : <video src={proof.media} controls muted className="max-w-full" /> : <p>Loading proof…</p>}
    </section>
  </div>;
}
