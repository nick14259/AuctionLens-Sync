# AuctionLens Sync

Shares auction house prices within your guild, for the
[AuctionLens](https://www.curseforge.com/wow/addons/auctionlens) addon on WoW: Forever.

Each member runs AuctionLens Sync next to the game. After you play, it sends the price
history AuctionLens recorded to your guild's group. It then puts everyone's prices into
a small addon, `AuctionLens_Crowd`, so item tooltips show the guild's newest price, even
for items you never scanned yourself.

This repository is the complete source of the app and of the server it talks to, so you
can see exactly what it reads, sends and stores before you run it.

## Download

Get `AuctionLens-Sync-<version>.exe` from [Releases](../../releases). It is a single
portable exe with nothing to install.

It is not code-signed, so the first time Windows shows "Windows protected your PC".
Click **More info**, then **Run anyway**. If you would rather not trust a download,
[build it yourself](#build-it-yourself).

## Use

1. Run the exe and enter the **join code** from your guild. The server address is
   already filled in. Add a name if you like; it appears on the group's scan log.
2. Choose your WoW: Forever folder (the one with `Wow.exe` in it), or start the game
   once and it finds the folder itself.
3. Play as usual. The app sits in the system tray: click the icon to open it,
   right-click for **Sync now**, **Start with Windows** and **Quit**.
4. After the first sync, restart WoW once so it finds the new `AuctionLens_Crowd` addon.
   After that, a `/reload` picks up each sync.

It syncs on its own after the game saves (logout, `/reload` or exit) and fetches the
guild's prices when the game starts. **Sync now** works any time.

The group's scan log, showing who synced and when, is at the server's address, for
example <https://auctionlens-project-server.vercel.app>. Enter the join code there.

## What it does with your data

**Reads** `WTF\Account\*\SavedVariables\AuctionLens.lua`, the file AuctionLens saves,
and never writes to it. From that file it uses, per market (region, realm and faction),
each item's newest price point and its daily price history.

It does **not** send:
- your intraday scan points
- item links
- your gold ledger
- your recipes or vendor lists
- character names, or anything else in the file

See `buildBatches` in [server/lib/sync/payload.js](server/lib/sync/payload.js).

**Sends** to your group's server:
- those prices
- the market name
- the name you entered, if any
- a random token it got when you joined

Nothing else. The first sync sends your whole history (a few MB). Later syncs send
only the last two days.

**Writes**:
- `Interface\AddOns\AuctionLens_Crowd\` (two files, replaced on every sync)
- its own settings, in `%APPDATA%\AuctionLens Sync\settings.json`

**Checks** every 15 seconds whether `Wow.exe` is running (`tasklist`), to know when the
game starts and stops. It does not read or touch the game's memory, does not send
input, and does not automate anything.

**The server** ([server/](server/)) keeps, per group, the members' merged price history
(90 days) and a log of the last 500 uploads. It stores only a hash of each member's
token, never the token. Anyone with the join code can join the group or view its scan
log; nobody without it can see anything.

## What is in here

| Path | What |
| --- | --- |
| [companion/desktop](companion/desktop) | The exe: Electron, a tray icon, the window below |
| [companion/overwolf](companion/overwolf) | The same app for Overwolf, plus the shared window and sync controller |
| [companion/cli.js](companion/cli.js) | The same as a command-line tool |
| [server/lib/sync](server/lib/sync) | Shared code: reading SavedVariables, AuctionLens's storage format, upload, download, merging |
| [server](server) | The server: Vercel functions, Postgres (Neon) schema, the scan log page |

## Build it yourself

You need Node.js 20 or later on Windows.

```bash
cd server && npm install && npm test && cd ..
cd companion/overwolf && npm install && npm test && cd ../..
cd companion/desktop && npm install && npm test
npm run dist        # -> dist/desktop/AuctionLens-Sync-<version>.exe
```

If `npm run dist` complains that Electron is missing, run
`node node_modules/electron/install.js` once.

To run your own server instead of the default one, follow
[server/README.md](server/README.md) and enter its address when you join.

## Licence

Source-available, all rights reserved: you may read, build and run it, but not
redistribute it. Fonts are SIL OFL 1.1. See [LICENSE](LICENSE).
