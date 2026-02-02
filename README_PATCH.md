# Patch: Fix 'START GAME' button after text-fit update

## What was fixed
- 'START GAME' on the Host Setup screen now starts the game correctly again.
- Removed the obsolete `socket.emit("host-start-game")` call (server doesn't handle it).
- Start now uses `host-task-update` for round 1 and switches Host UI to ROUND screen.

## Install
Replace `script.js` in your project with the `script.js` from this zip.

No other files are required for this fix.
