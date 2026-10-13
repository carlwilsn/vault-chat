// Top of the page: the header bar, the offline bar and the burger menu.
import { Burger, Gear } from "./icons";

export function Header() {
  return (
    <div className="hdr">
      <button className="icbtn" id="convBtn" aria-label="conversations">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8.5h16M4 15.5h11.2" />
        </svg>
        <span className="reddot" id="convdot"></span>
      </button>
      <button className="title" id="titleBtn">
        <span className="tx" id="titleTx">connecting…</span>
        <span className="sub" id="titleSub"></span>
      </button>
      <button className="vpill" id="vpill">
        <span className="d"></span> voice
      </button>
      <button className="icbtn" id="menuBtn" aria-label="menu">
        <Burger />
        <span className="reddot" id="menudot"></span>
      </button>
    </div>
  );
}

export function OffBar() {
  return (
    <div className="offbar">
      <b>box unreachable</b> retrying — messages will queue
    </div>
  );
}

const RowIco = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export function Menu() {
  return (
    <div className="menu" id="menu">
      <button className="mrow" data-page="chat">
        <RowIco>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </RowIco>
        <span className="nm">Chat</span>
      </button>
      <button className="mrow" data-page="alerts">
        <RowIco>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
        </RowIco>
        <span className="nm">Alerts</span>
        <span className="ct warn zero" id="mAl">0</span>
      </button>
      <button className="mrow" data-page="notes">
        <RowIco>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
        </RowIco>
        <span className="nm">Notes</span>
      </button>
      <button className="mrow" id="voiceRow">
        <RowIco>
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 19v3" />
        </RowIco>
        <span className="nm">Voice</span>
      </button>
      <button className="mrow" id="thinkRow">
        <RowIco>
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z" />
        </RowIco>
        <span className="nm">Show thinking</span>
        <span className="ct zero" id="thinkState">off</span>
      </button>
      <button className="mrow" id="settingsRow">
        <Gear />
        <span className="nm">Box &amp; settings</span>
        <span className="connpip" id="connpip"></span>
      </button>
    </div>
  );
}
