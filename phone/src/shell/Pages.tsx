// The three pages; `body.page-*` (set by setPage) picks the visible one.
import { Photo, SendArrow } from "./icons";

export function Pages() {
  return (
    <div className="body">
      <section className="page" id="pChat">
        <div id="msgs"></div>
        <div id="pinned"></div>
        <div className="ongoing" id="ongoing"></div>
        <div id="pendImgs"></div>
        <div className="composer">
          <div className="field">
            <button className="imgbtn" id="imgBtn" aria-label="photo">
              <Photo />
            </button>
            <input type="file" id="imgInput" accept="image/*" multiple hidden />
            <textarea id="input" rows={1} placeholder="Message…" enterKeyHint="enter" autoComplete="off"></textarea>
            <button className="send" id="sendBtn" aria-label="send">
              <SendArrow />
            </button>
          </div>
        </div>
        <div id="kb"></div>
      </section>
      <section className="page" id="pAl">
        <div className="scroll" id="alScroll"></div>
      </section>
      <section className="page" id="pNotes">
        <div className="ncompose">
          <textarea id="noteInput" rows={1} placeholder="Jot a note…" enterKeyHint="enter" autoComplete="off"></textarea>
          <button className="nadd" id="noteAddBtn">
            Save
          </button>
        </div>
        <div className="scroll" id="notesScroll"></div>
      </section>
    </div>
  );
}
