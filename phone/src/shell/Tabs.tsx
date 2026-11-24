// The bottom tab bar: Alerts (with the unread count) and Notes.
import { Bell, Pencil } from "./icons";

export function Tabs() {
  return (
    <nav className="tabs">
      <button className="tab" data-page="alerts">
        <Bell />
        Alerts
        <span className="badge zero" id="badge">
          0
        </span>
      </button>
      <button className="tab" data-page="notes">
        <Pencil />
        Notes
      </button>
    </nav>
  );
}
