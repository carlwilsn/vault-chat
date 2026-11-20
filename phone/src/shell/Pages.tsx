// The two pages; `body.page-*` (set by setPage) picks the visible one.
export function Pages() {
  return (
    <div className="body">
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
        <div className="nsearch">
          <input id="noteSearch" type="search" placeholder="Search notes" autoComplete="off" enterKeyHint="search" />
        </div>
        <div className="scroll" id="notesScroll"></div>
      </section>
    </div>
  );
}
