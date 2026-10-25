# Upload instructions (GitHub Pages)

1. Download and extract `SailLab_GitHub_Ready.zip`.
2. Open the extracted `SailLab_GitHub_Ready` folder. Select all files and the `icons` folder inside it.
3. In your existing GitHub repository, choose **Add file → Upload files**. Drag the selected contents into the upload area. Do not upload an extra enclosing folder: `index.html` must be at repository root.
4. Commit changes to the branch configured for GitHub Pages (usually `main`).
5. Open **Settings → Pages** and confirm the source branch/folder if needed.
6. Wait for deployment, then refresh your site. If you still see the old version, use a hard refresh and, if necessary, clear site data/service worker for the site.

Theme, widget visibility/size/order, zero offsets, race marks, wind legs and countdown settings are saved in local browser storage. Sessions are stored locally in IndexedDB. They are not automatically transferred between devices or browsers.

The Dashboard combines the former Live readings and Dashboard widgets. Use **Edit dashboard** to enable drag-and-drop, then choose **Save & lock** to switch to large-number presentation mode. Unlock by pressing and holding the lock screen for 3 seconds. Sensor controls, theme, sailing analysis mode, widget styling, session archive and import/export are under **Settings**. Analysis is separated into straight-line, tack and gybe sections. Dock Tune photos can be attached in the Session form and are stored locally with the session.
