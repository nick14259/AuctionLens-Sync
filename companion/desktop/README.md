# AuctionLens Sync (desktop)

The guild companion as one portable Windows exe that lives in the system tray. Same
window and same sync rules as the Overwolf app (`companion/overwolf`): it runs that
app's controller (`src/controller.js`) and window (`static/main.html`, `src/main.js`)
inside Electron, with these in place of Overwolf:

| Overwolf | Here |
| --- | --- |
| `overwolf.io.watchFile` | `fs.watch` on the SavedVariables folder |
| game start / stop events | `tasklist` every 15 s for Wow.exe; its folder from PowerShell |
| folder picker | the Windows folder dialog |
| dock icon | tray icon: click to open; right-click for Sync now, Start with Windows, Quit |

Closing or minimizing the window hides it to the tray; syncing goes on. A failed sync
in the background shows a Windows notification. On a machine that used the CLI
companion, the first start picks up its join and WoW folder.

## For a guild-mate

Send them `dist/desktop/AuctionLens-Sync-<version>.exe` (about 100 MB: it carries its
own Chromium) and the join code. They:

1. Run it. Windows SmartScreen says "Windows protected your PC" because the exe is not
   code-signed: **More info > Run anyway**. (Once per new version.)
2. Paste the join code > JOIN. (The server address is filled in:
   `https://auctionlens-project-server.vercel.app`, `DEFAULT_SERVER` in
   `server/lib/sync/client.js`.)
3. BROWSE to their `_forever_` folder (or start WoW once and it is found).
4. Right-click the tray icon > **Start with Windows**, so it is always running.
5. Restart WoW once after the first sync, so it finds the new `AuctionLens_Crowd` folder.

It keeps its settings in `%APPDATA%\AuctionLens Sync\settings.json`. The portable exe
unpacks itself to a temp folder on each start (a few seconds).

## Build

```bash
cd companion/desktop
npm install                    # electron + electron-builder + esbuild
node node_modules/electron/install.js   # only if node_modules/electron/dist is missing
npm test                       # host pieces: storage, CLI seeding, file watch, game poller
npm run dist                   # -> dist/desktop/AuctionLens-Sync-<version>.exe
npm start                      # run it unpackaged
```

From a terminal inside VS Code, Electron may start as plain Node because VS Code sets
`ELECTRON_RUN_AS_NODE=1`: clear it first (`$env:ELECTRON_RUN_AS_NODE=$null`). The built
exe is not affected.

`npm run smoke` (or the exe with `--smoke`) loads the window hidden with separate
settings, reports `SMOKE OK`, and exits; with `SMOKE_SHOT=<file.png>` it also saves what
the window drew. No tray, no game polling, no sync.

Bump `version` in `package.json` for each build you hand out.
