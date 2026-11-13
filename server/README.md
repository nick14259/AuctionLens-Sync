# AuctionLens guild server

Guild price sharing for AuctionLens: a few Vercel functions in front of a Neon Postgres
database. Members' companions upload their history after each session; everyone downloads
the guild's merged prices into `AuctionLens_Crowd`, which the addon shows as a separate,
read-only layer (tooltip line `guild (n)`, `/alens guild`).

Design and reasoning: `docs/CROWD_SYNC.md`. Not part of the addon zip.

## Deploy (once)

**0. Commit first.** Vercel deploys from GitHub, so `server/` (including
`package-lock.json`) must be pushed. `node_modules/` and `server/.data/` are gitignored.

**1. Vercel account and project**
1. Sign up at vercel.com with GitHub (Hobby plan, free; it is for non-commercial use,
   which a free addon is).
2. Add New > Project > Import the repo. Grant Vercel access to it if it is not listed
   (a private repo works).
3. On the configure screen:
   - **Root Directory:** Edit > `server`. This matters: it makes `server/api/*.js` the
     functions and `server/package.json` the dependencies.
   - **Framework Preset:** Other. Build/Output/Install commands: leave the defaults.
   - Environment variables: none yet.
4. Deploy. It succeeds without a database; the functions just answer 500 until step 2.
   Note the production URL: `https://<project>.vercel.app` (Settings > Domains).

**2. Database (Neon, through Vercel)**
1. Project > Storage > Create Database > **Neon** > Continue. Accept the Neon terms
   (this creates a Neon account linked to Vercel; no separate signup).
2. Plan: Free. **Region:** the one nearest Vercel's function region; Vercel defaults to
   Washington, D.C. (`iad1`), so pick **US East (N. Virginia), aws-us-east-1**. Every
   call is a few round trips to the database, so distance shows up directly.
3. Name it (e.g. `auctionlens`) > Create. On "Connect project", tick Production,
   Preview and Development > Connect. This adds `DATABASE_URL` (and a few `PG*`
   variables, unused) to the project.

**3. Tables**
1. Storage > your database > **Open in Neon** > SQL Editor.
2. Paste all of `server/schema.sql` > Run. Expect "success" with no rows. Running it
   again is harmless.
3. Tables tab: `groups`, `members`, `items`, `uploads` should be listed.

**4. Lock group creation (recommended)**
Settings > Environment Variables > Add: key `CREATE_SECRET`, value a long random string
(PowerShell: `[guid]::NewGuid().ToString("N")`), all environments > Save. Without it
anyone who finds the URL can create groups (they still cannot see yours).

**5. Redeploy** so the functions see the new variables: Deployments > newest > ... >
Redeploy. Environment variables only reach deployments made after they were added.

**6. Check it** (PowerShell; `curl` there is not real curl, so use Invoke-RestMethod):

```powershell
$u = "https://<project>.vercel.app"
Invoke-RestMethod "$u/api/status"
#  401 "missing or malformed token"  -> functions are up and DATABASE_URL is set
Invoke-RestMethod -Method Post "$u/api/join" -ContentType application/json -Body '{"code":"ZZZZ-ZZZZ"}'
#  404 "no group has that join code" -> the database answers and the tables exist
#  500 "server error"                -> see Logs below
```

**7. Create the guild and sync**

```powershell
node companion/cli.js config --wow "C:\Program Files (x86)\World of Warcraft\_forever_"
node companion/cli.js create https://<project>.vercel.app "Guild Name" --label Me --secret <CREATE_SECRET>
node companion/cli.js sync
```

Then restart the game client once (new addon folder), and `/alens guild`.

**When something fails:** Project > Logs shows each function call and anything it
printed; a 500 logs the real error there. Common causes: `DATABASE_URL is not set`
(step 2.3 or 5 skipped), `relation "groups" does not exist` (step 3 skipped). A **401
or an HTML login page** on every call means you are using a deployment-specific URL
(`<project>-<hash>-<team>.vercel.app`), which Vercel's Deployment Protection puts behind
a login; use the production domain.

**Updates:** every push to the default branch redeploys automatically. Pushes to other
branches make preview deployments, which share the same database (fine for one guild;
add a separate Neon branch for previews if that ever matters).

Hobby (free) plan limits that matter: 4.5 MB per request (the companion sends batches of
at most 3 MB), and Neon's free 0.5 GB. One guild-market of 90-day history is about
6 MB of text before Postgres compresses it, so a few dozen fit.

## API

All bodies are JSON. Authenticated calls take `Authorization: Bearer <token>`.

| Call | Body / query | Returns |
| --- | --- | --- |
| `POST /api/group` | `{ name, label? }` (+ `x-create-secret` header if set) | `{ group, joinCode, token }` |
| `POST /api/join` | `{ code, label? }` | `{ group, token }` |
| `GET /api/status` | - | group, join code, member count, markets, your upload marks |
| `POST /api/upload` | a batch, see `lib/sync/payload.js` | `{ ok, items, complete }` |
| `GET /api/download` | `?market=..&days=30&after=<key>` | a page of `[key, l, d]`; follow `next` |
| `POST /api/leave` | - | forgets this member (their data stays merged) |
| `POST /api/log` | `{ code }` (a join code; no token) | group, members, markets, last 100 uploads |

## Scan log page

`public/index.html`, served at the site root (`https://<project>.vercel.app/`): enter a
join code to see the group's members, markets and recent uploads, refreshed every
minute. A link can carry the code after `#` (`.../#K7QF-M2XR`), which the browser never
sends to the server. Anyone with the join code can see it, as anyone with it can join.
Members appear under the name they gave when joining (`--label`, or "Your name" in the
apps), else "unnamed member".

The log needs the `upload_log` table (added 2026-11-13): run `schema.sql` again in the
Neon SQL editor. Until then uploads work as before and the page says the log is not set
up. Uploads are logged when they finish; the newest 500 per group are kept.

Tokens are 32 random bytes; only their SHA-256 is stored. Join codes look like `K7QF-M2XR`.

## Develop

```bash
cd server
npm install
npm test              # 24 tests: codec vs Lua fixtures, parser, merge, API on PGlite, full round trip
node dev.js           # the same API on http://localhost:3000, data in server/.data
node dev.js --memory  # throwaway database
```

`lib/sync/` is shared with the companion and has no dependencies: the codec port, the
SavedVariables parser, batch building, merging and the `Data.lua` writer. When
`AuctionLens/Data/Codec.lua` changes, run `python tools/codec_fixture.py` and the tests.
When `DB.SCHEMA` changes, add its layout to `lib/sync/format.js`.
