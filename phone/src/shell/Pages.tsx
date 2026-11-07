// The three pages; `body.page-*` (set by setPage) picks the visible one.
import { Plus, SendArrow } from "./icons";

export function Pages() {
  return (
    <div className="body">
      <section className="page" id="pChat">
        <div id="msgs"></div>
        <div id="pinned"></div>
        <div className="ongoing" id="ongoing"></div>
        <div id="pendImgs"></div>
        {/* Signed out of Claude: this replaces the composer, in its place, with
            the same one sentence the laptop shows (src/claudeAuth.ts
            SIGN_IN_LINE.phone). Signing in itself is the laptop's — the token
            and the keychain are there — so this says where, rather than
            offering a button that could not finish the job here. */}
        <div className="signin" id="signin">
          <div className="signin-line" id="signinLine"></div>
          <div className="signin-where" id="signinWhere"></div>
        </div>
        <div className="composer">
          <div className="field">
            {/* "+": one picker for anything — iOS offers Take Photo, Photo Library and Choose File itself
                (no `accept`, no `capture`: either would narrow its menu). Photos go as images; other
                files upload to the box (POST /api/v2/attachment) and the agent gets their paths. */}
            <button className="imgbtn" id="imgBtn" data-el="attach" aria-label="Attach a photo or file">
              <Plus />
            </button>
            <input type="file" id="imgInput" multiple hidden />
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
