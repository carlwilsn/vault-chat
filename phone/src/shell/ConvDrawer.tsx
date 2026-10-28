// The left panel (left header button) and its scrim: Main, the projects, "+ New project"
// (src/threads.ts panelModel). Clear is in the thread's own bar (Header.tsx), one tap.

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
