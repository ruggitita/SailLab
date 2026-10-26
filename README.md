# SailLab — GitHub-ready build

This build preserves the existing GPS/session recorder, local IndexedDB storage, GPX import/export, start-line pinging, countdown and auto-transition to Dashboard, wind-shift leg recording, trim logging, and analysis. It adds the refreshed themes and dashboard display requested. Analysis is split into Straight-line, Tack and Gybe views; Dock Tune accepts compressed photo attachments stored with the session.

## What changed
- Renamed **Time to Burn** to **Time to Kill** in Start Line and Dashboard.
- Five selectable themes: Dark, Light, Ocean Blue, Electric Violet and Solar Yellow. The selected theme is saved in this browser.
- Compact Start Line buttons and cards. The Pin end is shown on the left and the Committee Boat on the right in the race map illustration; the actual map uses saved GPS pings.
- Dashboard now contains both the Wind Shift LED widget and a separate wind-direction/compass widget with port/starboard leg recording, baseline setting and reset controls. The standalone Wind page has been removed.
- Heel displays as a whole degree. Pitch is rounded to the nearest 0.5° and displayed with one decimal. SOG is displayed with one decimal.
- Session form now captures one Crew name field, opponents, onboard feeling, weather and racecourse notes, wind/wave estimates, wind/current directions, 1–5 gustiness and wave-state scales, equipment and sail selections, separate materials notes, and a dedicated Dock Tune table (shrouds, forestay, prebend, spreader position, diamond, rake, D1, D2, V1, V2). These fields are included when saving/exporting sessions.
- Live readings and Dashboard are unified in one Dashboard view. Widget customization uses the former Live-style selector for half/full width, font size, background/text color, visibility and ordering via Move up/Move down. Drag-and-drop has been removed. Dashboard offers layout presets and a Lock screen action; unlock with a 3-second press-and-hold.
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
- The LED shift bar compares the estimated direction with the baseline set in the Dashboard wind-direction widget.
- Map tiles require an internet connection. Session data is stored locally on the device/browser; export backups before clearing browser data.
- This is a prototype and must not be used as a safety-critical navigation or official race-timing instrument.


### iPhone-style instrument dashboard (v10)
The Dashboard now contains only five touch-friendly instruments: SOG, COG, heel (instant plus 5 s and 20 s averages, with a ±16° bubble bar), trim (pitch angle from the motion sensor, with 5 s and 30 s averages), and EWD (estimated wind direction with a four-LED shift indicator). Choose Race, Balanced, Minimal, or Big numbers at the top of the Dashboard. In Settings you can change each widget’s width, font size, colors, order, or visibility without drag-and-drop.

### Start-line squareness
After pinging Committee Boat and Pin, SailLab compares the line bearing with the estimated wind direction and reports the angular deviation from 90° (square). The estimate requires usable wind direction data from recorded port and starboard legs; it is only as reliable as the GPS courses and wind estimate.

## Phone layout editor and full-screen dashboard

Open **Dashboard → Edit layout** to edit the phone-shaped preview. Select SOG, COG, HEEL, TRIM or EWD to change its width, font size, card/text colours, visibility and position. Choose a preset (Race, Balanced, Minimal or Big numbers) for a starting layout. Tap **Save and full screen** to show the cockpit without the browser/app navigation; use **Exit full screen** to return to editing. The app requests Android/browser Screen Wake Lock where supported.

A web PWA cannot force Android to launch or reopen itself automatically when the phone's system lock screen is unlocked. Open SailLab and enter full-screen mode before sailing; install it to the home screen and allow screen-wake/location permissions where prompted. Device lock-screen behaviour remains controlled by Android.
