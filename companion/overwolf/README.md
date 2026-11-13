# AuctionLens Guild Sync (Overwolf app)

The companion as an Overwolf app: it syncs on its own, so guild-mates install it once
and forget it. Same work as `companion/cli.js`; both run `server/lib/sync/client.js`.

## What it does

| When | What |
| --- | --- |
| WoW writes SavedVariables (logout, `/reload`, exit) | upload + download, 20 s after the last write |
| WoW closes | the same, 15 s later (backstop if the file watch missed it) |
| WoW starts | download, so the guild's prices are in place by login |
| "Sync now" | upload + download |

The window: join or create a group, the WoW folder (found from the running game on
first launch if AuctionLens has data there), the last sync, the next one, a log.
Closing the window keeps the background page running; Quit stops it.

## Build

```bash
cd companion/overwolf
npm install          # esbuild, once
npm run build        # -> dist/overwolf/AuctionLensCompanion
npm test             # 12 tests: controller with a fake Overwolf against server/dev.js
```

`src/` is bundled into plain scripts (no ES modules at runtime); `static/` is copied;
fonts come from `AuctionLens/Media/Fonts` (OFL, licences included); icons are drawn by
`build.js`, so the repo holds no binaries.

## Run it in Overwolf (developer)

Overwolf only loads an unpacked app for a **whitelisted developer account**:

1. dev.overwolf.com > sign in with your Overwolf account > submit the app idea
   ("AuctionLens Guild Sync: shares auction house price history within a WoW guild").
   Wait for developer status **Approved** (it shows Pending until then).
2. Overwolf client > Settings > About > **Development options** > **Load unpacked
   extension** > select the `dist/overwolf/AuctionLensCompanion` folder (the folder,
   not a file in it). It appears in the dock as "AuctionLens Sync".
3. After a rebuild: Development options > the app's **Reload** button.
4. DevTools for its pages: start Overwolf with `--ow-enable-features=enable-dev-tools`,
   then Development options lists Inspect for the background page and the window.

Until approval, `node companion/cli.js sync` does the same by hand.

## To verify on the real client (VERIFY)

- Overwolf reports WoW: Forever as game class 765 (its `Wow.exe` is in Overwolf's
  game list; the manifest targets 765). If not, the game start/stop rows above do not
  fire - the SavedVariables watch and Sync now still work.
- `overwolf.io.watchFile` keeps reporting after WoW replaces the file on save (the
  controller re-arms on rename/delete events and after every sync).
- `readTextFile` on a ~19 MB SavedVariables file: expected a few hundred ms.
- Fetch to `https://*.vercel.app` from the app (listed in `externally_connectable`; the
  server also sends CORS headers).

## Publishing (later)

The Overwolf Appstore needs QA review after the app is submitted from the developer
console; distribution through it is what makes a guild-mate trust an install. Store
assets: icons are generated at the required 256x256; screenshots and a store
description are still to make.
