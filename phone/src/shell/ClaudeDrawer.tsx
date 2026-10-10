// The Box & settings drawer (#drawer): notifications, push test, the box's version.
import { Burger } from "./icons";

export function ClaudeDrawer() {
  return (
    <div id="drawer">
      <div className="panel">
        <div className="cl-hd" id="clHd">
          <span className="icbtn" aria-hidden="true" style={{ visibility: "hidden" }}></span>
          <div className="cl-title">Box &amp; settings</div>
          <button className="icbtn" id="drawerMenuBtn" aria-label="menu">
            <Burger />
          </button>
        </div>
        <div className="cl-gear open" id="clGear">
          <div className="grow">
            <span>Notifications</span>
            <button className="sw" id="pushSw" aria-label="notifications">
              <i></i>
            </button>
          </div>
          <div className="grow">
            <span id="pushState" style={{ fontSize: "11.5px", color: "var(--dim)" }}>
              Checking…
            </span>
            <button id="pushTestBtn" style={{ fontSize: "11.5px", color: "var(--text-secondary)", textDecoration: "underline" }}>
              send test
            </button>
          </div>
          <div className="grow">
            <span id="boxVer" style={{ fontSize: "11.5px", color: "var(--faint)" }}></span>
          </div>
        </div>
      </div>
    </div>
  );
}
