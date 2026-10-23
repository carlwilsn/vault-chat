// The left panel (left header button) and its scrim: Main, the projects, "+ New project"
// (src/threads.ts panelModel). The ⋯ menu: New separate chat, Clear, Older chats, Memory.

export function ConvDrawer() {
  return (
    <>
      <div className="scrim" id="scrim"></div>
      <div className="cdraw" id="cdraw">
        <div className="cdtop">
          <b>Chats</b>
          <button className="newbtn more" id="newBtn" aria-label="More">
            ⋯
          </button>
        </div>
        <div className="clist" id="clist"></div>
      </div>
    </>
  );
}
