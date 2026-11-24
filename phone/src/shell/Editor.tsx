// The note editor, full screen: Cancel / Save, the title, the body as live markdown (boot.ts draws its lines), and
// for a saved note Resolve (or Reopen) and Delete.
export function Editor() {
  return (
    <div className="ed" id="ed">
      <div className="ed-hd">
        <button id="edCancel">Cancel</button>
        <span id="edHd">New note</span>
        <button id="edSave" className="ed-save">
          Save
        </button>
      </div>
      <input id="edT" placeholder="Title" autoComplete="off" enterKeyHint="next" />
      <div id="edB" className="lm"></div>
      <div className="ed-ft" id="edFt">
        <button id="edRes">Resolve</button>
        <button id="edDel" className="danger">
          Delete
        </button>
      </div>
    </div>
  );
}
