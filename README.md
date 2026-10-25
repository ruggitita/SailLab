# SailLab — GitHub-ready build

This build preserves the existing GPS/session recorder, local IndexedDB storage, GPX import/export, start-line pinging, countdown and auto-transition to Dashboard, wind-shift leg recording, trim logging, and analysis. It adds the refreshed themes and dashboard display requested. Analysis is split into Straight-line, Tack and Gybe views; Dock Tune accepts compressed photo attachments stored with the session.

## What changed
- Renamed **Time to Burn** to **Time to Kill** in Start Line and Dashboard.
- Five selectable themes: Dark, Light, Ocean Blue, Electric Violet and Solar Yellow. The selected theme is saved in this browser.
- Compact Start Line buttons and cards. The Pin end is shown on the left and the Committee Boat on the right in the race map illustration; the actual map uses saved GPS pings.
- Dashboard Wind Shift widget shows GPS course/heading estimate, estimated true wind direction, a left/neutral/right LED bar and tack-recording controls. The baseline control is removed from Dashboard; the Wind Shifts page retains baseline controls.
- Heel displays as a whole degree. Pitch is rounded to the nearest 0.5° and displayed with one decimal. SOG is displayed with one decimal.
- Session form now captures one Crew name field, opponents, onboard feeling, weather and racecourse notes, wind/wave estimates, wind/current directions, 1–5 gustiness and wave-state scales, equipment and sail selections, separate materials notes, and a dedicated Dock Tune table (shrouds, forestay, prebend, spreader position, diamond, rake, D1, D2, V1, V2). These fields are included when saving/exporting sessions.
- Live readings and Dashboard are unified in one Dashboard view. Widget customization uses the former Live-style selector for width, font size, background/text color, visibility and ordering. Drag-and-drop is enabled in Edit dashboard mode. Saving the layout switches to large-number presentation mode and locks the screen; unlock with a 3-second press-and-hold.
- Settings consolidates theme, GPS enable/disable, IMU enable/disable, heel/pitch zero calibration, wake lock, sailing-mode selection, saved sessions, JSON/CSV export, GPX import and full backup. Session form no longer has the old “Log an event” panel and now includes separate foil/rudder settings.

- Analysis now includes GPS-derived maneuver candidates with Entry/Min/Exit SOG, average/minimum VMG, VMG distance, turn angle, maximum turn rate, maximum heel, deceleration and acceleration. It also reports course/wind angle, pitch, heel stability and speed-change stability, with All / Top 50% / Top 20% maneuver filters. Wind-referenced VMG requires a wind direction in Session settings. This is inspired by publicly documented sailing-performance metrics; it is not Vantage Sailing software or a reproduction of its proprietary algorithms. Maneuver detection is heuristic and needs on-water validation.

## Publish on GitHub Pages
1. Download and extract the ZIP. Open the `SailLab_GitHub_Ready` folder.
2. Upload **the contents of this folder** to the root of your existing GitHub repository, replacing the old files. Keep `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` and the `icons` folder together.
3. Commit the changes to your Pages branch (usually `main`).
4. Wait for GitHub Pages to deploy, then reload your site. If the old version remains, do a hard refresh or clear the site's cached data/service worker.


## Important limitations
- GPS and motion sensors require a supported browser, permission and HTTPS.
- Standard browser APIs cannot reliably use hardware volume buttons to unlock the screen; presentation mode unlocks with a 3-second press-and-hold.
- The Wind Shift direction is estimated from GPS courses on port and starboard tacks, not measured by a true-wind sensor. COG is not always identical to bow heading.
- The LED shift bar compares the estimated direction with the baseline set on the Wind Shifts page.
- Map tiles require an internet connection. Session data is stored locally on the device/browser; export backups before clearing browser data.
- This is a prototype and must not be used as a safety-critical navigation or official race-timing instrument.
