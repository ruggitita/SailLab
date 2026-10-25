# SailLab — GitHub-ready build

This build preserves the existing GPS/session recorder, local IndexedDB storage, GPX import/export, start-line pinging, countdown and auto-transition to Cockpit, wind-shift leg recording, trim logging, and analysis. It adds the refreshed themes and cockpit display requested.

## What changed
- Renamed **Time to Burn** to **Time to Kill** in Start Line and Cockpit.
- Five selectable themes: Dark, Light, Ocean Blue, Electric Violet and Solar Yellow. The selected theme is saved in this browser.
- Compact Start Line buttons and cards. The Pin end is shown on the left and the Committee Boat on the right in the race map illustration; the actual map uses saved GPS pings.
- Cockpit Wind Shift widget shows GPS course/heading estimate, estimated true wind direction, a left/neutral/right LED bar and tack-recording controls. The baseline control is removed from Cockpit; the Wind Shifts page retains baseline controls.
- Heel displays as a whole degree. Pitch is rounded to the nearest 0.5° and displayed with one decimal. SOG is displayed with one decimal.
- Session form now captures one Crew name field, opponents, onboard feeling, weather and racecourse notes, wind/wave estimates, wind/current directions, 1–5 gustiness and wave-state scales, equipment and sail selections, separate materials notes, and a dedicated Dock Tune table (shrouds, forestay, prebend, spreader position, diamond, rake, D1, D2, V1, V2). These fields are included when saving/exporting sessions.
- Cockpit widget drag-and-drop and width selection (Half/Wide) in Edit widgets. SOG and Wind Shift are wide by default.
- Screen lock remains visible over the data and unlocks with a 1.2-second long press. The explicit Unlock now button remains as an accessibility fallback.

## Publish on GitHub Pages
1. Download and extract the ZIP. Open the `SailLab_GitHub_Ready` folder.
2. Upload **the contents of this folder** to the root of your existing GitHub repository, replacing the old files. Keep `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` and the `icons` folder together.
3. Commit the changes to your Pages branch (usually `main`).
4. Wait for GitHub Pages to deploy, then reload your site. If the old version remains, do a hard refresh or clear the site's cached data/service worker.

## Important limitations
- GPS and motion sensors require a supported browser, permission and HTTPS.
- Standard browser APIs cannot reliably use hardware volume buttons to unlock the screen; this build uses a long press.
- The Wind Shift direction is estimated from GPS courses on port and starboard tacks, not measured by a true-wind sensor. COG is not always identical to bow heading.
- The LED shift bar compares the estimated direction with the baseline set on the Wind Shifts page.
- Map tiles require an internet connection. Session data is stored locally on the device/browser; export backups before clearing browser data.
- This is a prototype and must not be used as a safety-critical navigation or official race-timing instrument.
