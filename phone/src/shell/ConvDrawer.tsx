// The Conversations drawer (left header button) and its scrim.
import { Plus } from "./icons";

export function ConvDrawer() {
  return (
    <>
      <div className="scrim" id="scrim"></div>
      <div className="cdraw" id="cdraw">
        <div className="cdtop">
          <b>Conversations</b>
          <button className="newbtn" id="newBtn">
            <Plus w="2.2" />
            New
          </button>
        </div>
        <div className="clist" id="clist"></div>
        <button className="cclear" id="clearChatsBtn">
          Clear chats from this view
        </button>
      </div>
    </>
  );
}
