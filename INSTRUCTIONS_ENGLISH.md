# SailLab — quick setup (English UI)

1. Download and extract the ZIP.
2. Open your existing GitHub repository. Choose **Add file → Upload files**.
3. Upload the contents of this folder into the repository root, replacing the existing `index.html`, `app.js`, and `styles.css`. Keep `manifest.webmanifest`, `sw.js`, and the `icons` folder.
4. Commit the changes. Under **Settings → Pages**, make sure GitHub Pages deploys from branch `main`, folder `/(root)`.
5. Open the same GitHub Pages URL. If the old version remains, hard-refresh or close and reopen the site to refresh the service-worker cache.

## Start-line countdown
- Enter the official remaining time in seconds.
- **Start countdown** starts the entered duration immediately.
- **Sync** snaps a running countdown down to the next whole-minute mark (for example, 03:20 becomes 03:00). When stopped, it rounds the selected duration down to a whole minute without starting the countdown.
- **− 1 min / + 1 min** adjusts the selected time and also adjusts a running countdown.
- At zero, SailLab displays START and automatically switches to Cockpit.

## Cockpit and wind shifts
Wind-shift recording is now part of the Cockpit widget. Start a session and enable GPS. Tap **Start PORT tack** or **Start STARBOARD tack** when settled on that tack; switch to the other button after the tack and sail a steady leg. Set a baseline after both tacks have usable GPS course samples. The estimate is based on average course over ground, not a direct wind sensor.

## Notes
GPS requires location permission and HTTPS. The map requires internet access. Time-to-line and time-to-burn are estimates based on current speed and simplified geometry; verify visually and do not rely on them as safety-critical instruments.
