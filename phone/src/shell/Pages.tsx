// The two pages; `body.page-*` (set by setPage) picks the visible one. Alerts: one card per alert. Notes: the
// Open / Resolved switch, the cards, and the "New note" bar that opens the editor.
import { Plus } from "./icons";

export function Pages() {
  return (
    <div className="pages">
      <section className="page" id="pAlerts">
        <div className="scroll" id="alScroll"></div>
      </section>
      <section className="page" id="pNotes">
        <div className="seg" id="seg">
          <button className="on" data-f="open">
            Open
          </button>
          <button data-f="resolved">Resolved</button>
        </div>
        <div className="scroll" id="nScroll"></div>
        <button className="newbar" id="newBtn">
          <Plus />
          New note
        </button>
      </section>
    </div>
  );
}
