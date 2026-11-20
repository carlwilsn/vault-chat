# board/ (removed)

The iPad whiteboard was removed. These three files only exist because the
installed ship script (server/simpleShipHost.ts, installed once and never loaded
from a branch) still runs `tsc -p board` and `vite build --config board/vite.config.ts`.
The source gate list no longer names the board; delete this folder after the ship
script is next installed.
