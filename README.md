# SailLab — GitHub-ready build

This build preserves the existing GPS/session recorder, local IndexedDB storage, GPX import/export, start-line pinging, countdown and auto-transition to Dashboard, wind-shift leg recording, trim logging, and analysis. It adds the refreshed themes and dashboard display requested. Analysis is split into Straight-line, Tack and Gybe views; Dock Tune accepts compressed photo attachments stored with the session.

## What changed
- Renamed **Time to Burn** to **Time to Kill** in Start Line and Dashboard.
- Eight selectable themes: Night, Daylight, Ocean, Electric, Solar, Regatta Teal, Sunset and High Contrast. The selected theme is saved in this browser.
- Compact Start Line buttons and cards. The Pin end is shown on the left and the Committee Boat on the right in the race map illustration; the actual map uses saved GPS pings.
- Dashboard now contains both the Wind Shift LED widget and a separate wind-direction/compass widget with port/starboard leg recording, baseline setting and reset controls. The standalone Wind page has been removed.
- Heel displays as a whole degree. Pitch is rounded to the nearest 0.5° and displayed with one decimal. SOG is displayed with one decimal.
- Session form now captures one Crew name field, opponents, onboard feeling, weather and racecourse notes, wind/wave estimates, wind/current directions, 1–5 gustiness and wave-state scales, equipment and sail selections, separate materials notes, and a dedicated Dock Tune table (shrouds, forestay, prebend, spreader position, diamond, rake, D1, D2, V1, V2). These fields are included when saving/exporting sessions.
- Live readings and Dashboard are unified in one Dashboard view. Widget customization uses the former Live-style selector for half/full width, font size, background/text color, visibility and ordering via Move up/Move down. Drag-and-drop has been removed. Dashboard has its own Appearance editor with a phone-shaped preview, per-widget visibility toggles, width/font/colour controls and four working presets. Lock screen opens the selected instruments in full-screen and a long press unlocks it.
- Settings consolidates GPS enable/disable, IMU enable/disable, heel/pitch zero calibration, wake lock, sailing-mode selection, saved sessions, JSON/CSV export, GPX import and full backup. Appearance and themes are configured from Dashboard. Session form no longer has the old “Log an event” panel and now includes separate foil/rudder settings.

- Analysis now includes GPS-derived maneuver candidates with Entry/Min/Exit SOG, average/minimum VMG, VMG distance, turn angle, maximum turn rate, maximum heel, deceleration and acceleration. It also reports course/wind angle, pitch, heel stability and speed-change stability, with All / Top 50% / Top 20% maneuver filters. Wind-referenced VMG requires a wind direction in Session settings. This is inspired by publicly documented sailing-performance metrics; it is not Vantage Sailing software or a reproduction of its proprietary algorithms. Maneuver detection is heuristic and needs on-water validation.

## Publish on GitHub Pages
1. Download and extract the ZIP. Open the `SailLab_GitHub_Ready` folder.
2. Upload **the contents of this folder** to the root of your existing GitHub repository, replacing the old files. Keep `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` and the `icons` folder together.
3. Commit the changes to your Pages branch (usually `main`).
4. Wait for GitHub Pages to deploy, then reload your site. If the old version remains, do a hard refresh or clear the site's cached data/service worker.


## Important limitations
- GPS and motion sensors require a supported browser, permission and HTTPS.
- Standard browser APIs cannot reliably use hardware volume buttons to unlock the screen; presentation mode unlocks with a 3-second press-and-hold.
- EWD estimates wind direction automatically from recent GPS course clusters on stable legs and refreshes every 20 seconds. It is not a true-wind sensor; COG is not always identical to bow heading and the estimate can be wrong during manoeuvres, downwind sailing, current or unstable GPS conditions.
- The LED shift bar compares the estimated direction with the baseline set in the Dashboard wind-direction widget.
- Map tiles require an internet connection. Session data is stored locally on the device/browser; export backups before clearing browser data.
- This is a prototype and must not be used as a safety-critical navigation or official race-timing instrument.


### iPhone-style instrument dashboard (v11)
The Dashboard now contains only five touch-friendly instruments: SOG, COG, heel (instant plus 5 s and 20 s averages, with a ±16° bubble bar), trim (pitch angle from the motion sensor, with 5 s and 30 s averages), and EWD (estimated wind direction with a four-LED shift indicator). Choose Race, Balanced, Minimal, or Big numbers at the top of the Dashboard. In Dashboard → Appearance you can change each widget’s width, font size, colours, order, or visibility without drag-and-drop. SOG shows the rolling 20-second average.

### Start-line squareness
After pinging Committee Boat and Pin, SailLab compares the line bearing with the estimated wind direction and reports the angular deviation from 90° (square). The estimate requires enough accurate GPS course samples and two distinct stable course clusters; it is only as reliable as the GPS courses and wind estimate.

## Phone layout editor and full-screen dashboard

Open **Dashboard → Appearance** to edit the phone-shaped preview. Select which of SOG, COG, HEEL, TRIM and EWD are visible, then adjust width, font size, card/text colours and order. Choose Race, Balanced, Minimal or Big numbers. Tap **Lock screen** to show only the selected widgets at full screen; long-press the screen for about 2 seconds to unlock and return to the editable Dashboard. The app requests Android/browser Screen Wake Lock where supported. The Start screen can also ping the upwind mark and displays estimated line length coverage time at current SOG. A Dashboard Flag stores timestamp and GPS position, with an optional note or photo.

A web PWA cannot force Android to launch or reopen itself automatically when the phone's system lock screen is unlocked. Open SailLab and enter full-screen mode before sailing; install it to the home screen and allow screen-wake/location permissions where prompted. Device lock-screen behaviour remains controlled by Android.

### Version 8 implementation notes
- Dashboard Appearance is now directly on the Dashboard; choose widget visibility, size, order, text size, card/text colours and one of eight themes.
- Lock screen opens a full-screen, touch-blocking instrument display. Long-press for about 1.8 seconds to unlock. The app requests GPS and motion sensor access when entering lock mode; browser permissions may still need to be granted.
- EWD attempts an automatic course-cluster/bisector estimate from accurate GPS COG samples and refreshes every 20 seconds. The eight LED sectors indicate a provisional lift/header only when a current tack side can be inferred. This is a heuristic estimate, not instrument-grade true wind.
- Dashboard Flag saves timestamp, last GPS position and optional note/photo locally. Ping Upwind Mark adds a waypoint and a dashed leg from the start-line midpoint on the race map.


## Interactive phone layout editor (v10)
Open Dashboard → Appearance. In the phone-shaped preview, tap any widget to select it, then use the on-phone controls to move it, switch half/full width, increase or decrease its text size, hide/show it, or apply a quick card colour. The editor works by touch and does not require drag-and-drop. Detailed colour and text controls remain available in Appearance. Your layout is saved locally on this device.
