# Upload instructions (GitHub Pages)

1. Download and extract `SailLab_GitHub_Ready.zip`.
2. Open the extracted `SailLab_GitHub_Ready` folder. Select all files and the `icons` folder inside it.
3. In your existing GitHub repository, choose **Add file → Upload files**. Drag the selected contents into the upload area. Do not upload an extra enclosing folder: `index.html` must be at repository root.
4. Commit changes to the branch configured for GitHub Pages (usually `main`).
5. Open **Settings → Pages** and confirm the source branch/folder if needed.
6. Wait for deployment, then refresh your site. If you still see the old version, use a hard refresh and, if necessary, clear site data/service worker for the site.

Theme, widget visibility/size/order, zero offsets, race marks, wind legs and countdown settings are saved in local browser storage. Sessions are stored locally in IndexedDB. They are not automatically transferred between devices or browsers.

The Dashboard combines the former Live readings, Dashboard widgets and Wind tools. There is no drag-and-drop editing. Use the **Race / Balanced / Minimal / Big numbers** preset chips on Dashboard to switch layouts. In Settings, choose a widget to set half/full width, font size, background/text colors, hide/show it, or move it up/down. Use **Lock** from Dashboard for the large-number presentation; unlock by pressing and holding the overlay for 3 seconds. Sensor controls, theme, sailing analysis mode, session archive and import/export are under **Settings**. Analysis is separated into straight-line, tack and gybe sections. Dock Tune photos can be attached in the Session form and are stored locally with the session.


### Dashboard layouts and instruments
The Dashboard is touch-first and does not use drag-and-drop. Select Race, Balanced, Minimal, or Big numbers on the Dashboard. The available widgets are SOG, COG, Heel, Trim, and EWD. Heel shows a ±16° bubble bar and 5 s / 20 s averages. Trim uses the phone motion sensor’s pitch angle and shows 5 s / 30 s averages. EWD shows estimated wind direction and four shift LEDs. Widget width, font size, colors, order and visibility can be changed in Settings.

### Line square calculation
Ping both ends of the start line. Once the app can estimate wind direction from recorded port and starboard legs, the Start screen displays the deviation from a square line (90° between line and wind direction).

## Phone-shaped dashboard editor and full-screen mode

In Dashboard, tap **Edit layout**. Use the phone preview and select SOG, COG, HEEL, TRIM or EWD to change width, font size, background/text colour, visibility and order. Pick a preset to start from, then tap **Save and full screen**. Use **Exit full screen** to return. SailLab requests Screen Wake Lock if the browser supports it.

Important Android limitation: a web app cannot force Android to open SailLab automatically every time the system lock screen is unlocked. Launch SailLab from its installed home-screen icon and enter full-screen mode before sailing. Android controls system lock-screen and app-launch behaviour.
