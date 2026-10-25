# SailLab — English PWA with GPS, heel and pitch estimates

A mobile-first Progressive Web App for recording sailing sessions. Session data is stored locally in IndexedDB; no GPS data is sent to a server.

## Files
- `index.html` — English user interface.
- `styles.css` — responsive dark theme.
- `app.js` — GPS tracking, session recording, local storage, events, CSV/JSON export, GPX import, and optional phone orientation readings.
- `manifest.webmanifest` — PWA metadata.
- `sw.js` — offline cache.
- `icons/icon.svg` — app icon.

## Publish with GitHub Pages
1. Upload all files and the `icons/` folder to the repository root.
2. Open **Settings → Pages**.
3. Choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then save.
4. Open the HTTPS URL GitHub Pages provides.

## Enable heel and pitch
1. Open SailLab in Safari or Chrome over HTTPS.
2. Tap **Enable motion sensors** and grant permission if prompted.
3. Securely mount the phone to the boat and align it consistently with the boat axes.
4. Check readings while stationary and during a controlled test.

### Important sensor limitation
The app reads `DeviceOrientationEvent` angles from the phone. These are **phone roll and pitch estimates**, not certified boat heel/pitch measurements. Mounting angle, phone orientation, sensor bias, vibration and device/browser differences affect the values. No calibration, filtering, or marine-grade validation is included yet. If the phone is not fixed and aligned with the boat, the values do not represent the boat's attitude. Some devices/browsers may not expose motion readings, or may require a user gesture/permission.

`COG` means **Course Over Ground** and comes from GPS course (`coords.heading`) when the browser supplies it. It is not the boat's bow heading.

## Known limitations
- A PWA cannot guarantee GPS logging while in the background or with the screen locked; mobile operating systems may suspend it.
- Heel and pitch are only recorded when the motion API supplies readings; unavailable readings remain null.
- GPS speed and COG may be null when not supplied by the device.
- GPS sample rate depends on device, browser, sky visibility and OS power management.
- Wind estimation, synchronized multi-session comparison, automatic manoeuvre recognition, external sensors, BLE load cells and heart-rate integration are not implemented.
- GPX import preserves timestamps, coordinates and altitude when present; it does not invent missing values.
- Regularly export a JSON backup. Browser storage can be cleared by the user or operating system.

## Recommended test checklist
- Confirm the GPS status becomes active outdoors.
- Enable motion sensors and verify that heel/pitch values change when you gently tilt the phone.
- Mount the phone securely and align its axes with the boat before interpreting readings.
- Record, pause, resume, log a tack/gybe, finish and reopen the session.
- Export CSV and JSON, then import a GPX test file.
- Test on the actual iPhone/Android models you plan to use, including screen lock/background behaviour.


## New in this package
- **Zero calibration:** use `Set HEEL zero` and `Set PITCH zero` while the boat/phone is held in the chosen reference position. Current readings are stored as offsets in this browser and subtracted from subsequent readings. This is a simple offset only, not full sensor calibration.
- **Screen lock:** `Lock screen` opens an in-app overlay to reduce accidental touches. Tap the overlay three times to unlock, or use the on-screen `Unlock now` control. A normal PWA cannot reliably read hardware volume-button presses, so three volume presses cannot be used as a dependable unlock gesture.
- **Keep screen awake:** uses the Screen Wake Lock API where supported and permitted. The operating system may release it when the app goes to the background or battery-saving conditions apply.
- **Widget customization:** select a LIVE metric widget and set width, font size, background/text colors, visibility, and order. Settings are saved locally in browser storage.

## Important screen-lock distinction
The in-app lock is not an operating-system security lock and does not prevent the user from leaving the app or using device controls. It only blocks accidental touches inside the SailLab page. The web app cannot guarantee recording while backgrounded or screen-locked by the OS.


## Race line, wind shifts and custom cockpit (new)

- **Start line:** tap **Enable GPS** and wait for a fix, then tap **Ping committee boat** at the committee end and **Ping pin** at the pin end. Set the seconds to the gun and start the countdown. The app shows line-segment distance, line length, estimated time to the line at current SOG, and the time to burn (countdown minus estimated arrival time). Endpoints and countdown duration are saved locally.
- **Map:** the race and cockpit maps show the boat position, committee boat, pin, and start line. Map tiles are provided by OpenStreetMap and need an internet connection. GPS needs HTTPS and browser location permission.
- **Wind shifts:** start a session, record GPS while sailing a steady upwind leg, and tap the relevant port/starboard button when settling onto each tack. When switching to the other tack, the previous leg is finalized. After at least one usable leg on each tack, the app estimates wind direction from the bisector of average COGs. Tap **Set current direction as baseline** to display subsequent clockwise/right and counter-clockwise/left shifts. For better estimates, sail steady legs and use multiple tacks.
- **Cockpit widgets:** open **Cockpit → Edit widgets** to show/hide cards. Drag cards to reorder them. The layout is saved locally. The cockpit includes a map, SOG/COG, heel, pitch, wind shift, start-line timing, a trend chart, and a manual trim logger.
- **Trim:** there is no trim sensor connected in this build. Enter trim values or a consistent trim score manually; the app calculates their average and plots logged values alongside heel readings. Trim readings are stored locally on this device.

### Tactical limitations
The start-line time estimate assumes direct approach at constant current GPS speed; it does not account for approach angle, acceleration, current, manoeuvres or boat-specific start strategy. The line distance is the shortest distance to the finite segment between the two pinged endpoints. Wind direction is a GPS-course bisector estimate, not a measured wind vane/anemometer reading. GPS COG can be affected by current and leeway. Use these tools as tactical aids, verify readings on the water, and do not rely on them for navigation or safety-critical decisions.


## Latest race workflow
The front-end interface is in English. The Start Line page supports a countdown, one-minute adjustments, and a Sync action. When the countdown reaches zero, the app automatically opens the Cockpit. Wind-shift controls are integrated into the Cockpit's Wind widget; the separate Wind navigation item has been removed.

Sync snaps a running countdown down to the next whole-minute mark: for example, 03:20 becomes 03:00. If the countdown is not running, it rounds the selected duration down to a whole minute without starting it. It does not receive an official race committee signal.
