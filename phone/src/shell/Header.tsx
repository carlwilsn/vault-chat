// Top of the page: the page's title (and a calm "Connecting…" while the box is out of reach), search (Notes) and
// the gear that opens Settings; below it the notes search field, shown by the search icon.
import { Gear, Search } from "./icons";

export function Header() {
  return (
    <>
      <div className="hdr">
        <h1 id="title">Alerts</h1>
        <span className="conn" id="conn">Connecting…</span>
        <button className="ib" id="searchBtn" aria-label="search">
          <Search />
        </button>
        <button className="ib" id="gearBtn" aria-label="settings">
          <Gear />
        </button>
      </div>
      <div className="search" id="search">
        <input id="q" type="search" placeholder="Search notes" autoComplete="off" enterKeyHint="search" />
      </div>
    </>
  );
}
