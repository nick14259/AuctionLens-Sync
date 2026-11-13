# AuctionLens companion

Moves guild price data between your SavedVariables and the guild server
(`server/`). This is the command-line edition, for trying the loop now; the Overwolf app
will do the same thing on its own after every logout.

Needs Node 20 or later. No install step: it uses only Node's own modules and
`server/lib/sync/`.

```bash
# once: point it at your WoW: Forever folder
node companion/cli.js config --wow "C:\Program Files (x86)\World of Warcraft\_forever_"

# one guild member creates the group (add --secret <CREATE_SECRET> if the server has one)
node companion/cli.js create https://<project>.vercel.app "My Guild" --label Me
#   -> prints a join code, e.g. K7QF-M2XR

# everyone else joins with it
node companion/cli.js join https://<project>.vercel.app K7QF-M2XR --label Them

# after playing (log out or /reload first, so the game has written its SavedVariables)
node companion/cli.js sync          # upload, then download
node companion/cli.js status
```

What it does:

- **Upload** reads `WTF\Account\*\SavedVariables\AuctionLens.lua`, never writes it. It
  sends each item's newest price and its daily history; the first upload sends all of
  it (about 6 MB for a 33,000-item market, in batches), later ones only the last two
  days. Intraday scan points, links, ledger, recipes and character data never leave.
- **Download** writes `Interface\AddOns\AuctionLens_Crowd\` (`.toc` + `Data.lua`). The
  first time, restart the game client so it finds the new addon folder; after that a
  `/reload` picks up each sync. In game: `/alens guild`, and a `guild (n)` line on item
  tooltips.

The config (server, token, WoW folder) is kept in `%APPDATA%\AuctionLensCompanion\config.json`.
The token is the only credential; `leave` forgets it on the server.
