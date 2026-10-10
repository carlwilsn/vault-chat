// The bottom sheet: the detail surface for workers, missions, alerts, schedules.
import { Back } from "./icons";

export function Sheet() {
  return (
    <>
      <div className="sheet-scrim" id="sheetScrim"></div>
      <div className="sheet" id="sheet">
        <div className="sheet-grabwrap" id="sheetGrab">
          <div className="sheet-grab"></div>
        </div>
        <div className="sheet-head" id="sheetHead">
          <button className="sheet-back" id="sheetBack" aria-label="back" style={{ display: "none" }}>
            <Back />
          </button>
          <div className="sheet-ico" id="sheetIco"></div>
          <div className="sh-meta">
            <div className="sheet-intent" id="sheetIntent"></div>
            <div className="sheet-title" id="sheetTitle"></div>
          </div>
          <button className="sheet-action" id="sheetAction" style={{ display: "none" }}></button>
          <button className="sheet-x" id="sheetX">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="sheet-body" id="sheetBody"></div>
        <div className="sheet-foot" id="sheetFoot" style={{ display: "none" }}></div>
      </div>
    </>
  );
}
