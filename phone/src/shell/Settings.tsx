// Settings, a bottom sheet behind the gear: push on this phone, a test push, the box's version and connection.
export function Settings() {
  return (
    <>
      <div className="scrim" id="scrim"></div>
      <div className="sheet" id="sheet">
        <div className="grab" id="grab"></div>
        <h2>Settings</h2>
        <div className="srow">
          <div>
            <div>Push on this phone</div>
            <div className="sub" id="pushState">
              Checking…
            </div>
          </div>
          <button className="sw" id="pushSw" role="switch" aria-checked="false" aria-label="Push on this phone">
            <i></i>
          </button>
        </div>
        <div className="srow">
          <span className="sub">Test notification</span>
          <button className="link" id="pushTestBtn">
            Send test
          </button>
        </div>
        <div className="srow">
          <span className="sub">Box</span>
          <span className="sub" id="boxVer"></span>
        </div>
      </div>
    </>
  );
}
