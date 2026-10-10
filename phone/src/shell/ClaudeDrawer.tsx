// The Claude screen (#drawer): feedback queue, per-report threads, general chat.
import { Back, Burger, Gear, Plus, SendArrow } from "./icons";

const none = { display: "none" } as const;

export function ClaudeDrawer() {
  return (
    <div id="drawer">
      <div className="panel">
        <div className="cl-hd" id="clHd">
          {/* queue header: gear · Feedback|Chats · burger nav. The classic
              Feather cog: an 8-spoke variant read as a star (b1900639). */}
          <button className="icbtn" id="clGearBtn" aria-label="settings">
            <Gear />
          </button>
          <div className="cl-seg" id="clSeg">
            <button id="clTabFb" className="on">
              Feedback
            </button>
            <button id="clTabChat">Chat</button>
          </div>
          <div className="cl-back" id="clBack" style={none}>
            <button className="icbtn" id="clBackBtn" aria-label="back" style={{ minWidth: "34px" }}>
              <Back />
            </button>
            <div className="tt" id="clBackTitle"></div>
          </div>
          <button className="icbtn" id="drawerMenuBtn" aria-label="menu">
            <Burger />
          </button>
        </div>
        <div className="cl-gear" id="clGear">
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
        <div className="cl-body" id="clBody">
          {/* one row serves both tabs: "New feedback" on the queue, "New chat" on Chat */}
          <button className="fb-new" id="fbNewBtn">
            <Plus />
            <span id="fbNewLbl">New feedback — what felt off?</span>
          </button>
          {/* queue view (default) */}
          <div id="clQueue">
            <div id="fbList"></div>
          </div>
          {/* conversation view (a report thread, or the general chat) */}
          <div id="clConv" style={none}>
            <div className="cl-brief" id="clBrief" style={none}>
              <div className="eb">The ask</div>
              <div className="rep" id="clBriefText"></div>
              <div className="diag" id="clBriefDiag" style={none}>
                <div className="eb" id="clBriefDiagLbl">
                  Claude looked into this
                </div>
                <div className="rep" id="clBriefDiagText"></div>
                <div className="nudge" id="clBriefDiagNudge" style={none}>
                  Reply below and I’ll pick it up from here.
                </div>
              </div>
              <div className="meta" id="clBriefMeta"></div>
            </div>
            <div id="coderLog" className="coder-log"></div>
          </div>
        </div>
        <div className="cl-foot" id="clFoot" style={none}>
          <button className="coder-new" id="coderNewBtn" aria-label="new chat — clear this conversation">
            <Plus join />
          </button>
          <div className="coder-input">
            <textarea id="coderTa" rows={1} placeholder="Message…" enterKeyHint="enter" autoComplete="off"></textarea>
            <button className="coder-send" id="coderSend" aria-label="send">
              <SendArrow />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
