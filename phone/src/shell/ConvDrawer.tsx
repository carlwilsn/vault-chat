// The left panel (left header button) and its scrim: Main, the projects, "+ New project"
// (src/threads.ts panelModel). Each row's ⋯ includes device-local Clear.

export function ConvDrawer() {
  return (
    <>
      <div className="scrim" id="scrim"></div>
      <div className="cdraw" id="cdraw">
        <div className="cdtop">
          <b>Chats</b>
        </div>
        <div className="clist" id="clist"></div>
      </div>
    </>
  );
}
