// The full-screen voice view (body.voice), minimised to the header pill.
export function Voice() {
  return (
    <div id="voice">
      <div className="vtop">
        <button className="icbtn" id="vMinBtn" aria-label="keep talking while you read">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      <div className="vmid">
        <div className="viz" id="viz"></div>
        <div className="vwait" id="vwait"></div>
        <div className="vconn">Connecting…</div>
        <div className="verr" id="verr"></div>
      </div>
      <div className="vend">
        <div className="vbtns">
          <button className="vx" id="vMuteBtn" aria-label="mute mic" aria-pressed="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="21" x2="12" y2="17" />
              <line x1="9" y1="21" x2="15" y2="21" />
              <line className="slash" x1="3" y1="3" x2="21" y2="21" strokeWidth="2.4" />
            </svg>
          </button>
          <button className="vx" id="vEndBtn" aria-label="end voice">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <span className="vhint" id="vhint"></span>
      </div>
    </div>
  );
}
