// Everything the API does to the database. Takes `query(text, params) -> rows`, so the
// same code runs on Neon in production and on PGlite in tests and local development.

import { createHash, randomBytes } from "node:crypto";
import { decodeDeltaRows, encodeDeltaRows, decodeRow } from "./sync/codec.js";
import { D, P, WIRE, layout, dayIndex, validMarket, validItemKey, validCodec, canonicalMarket } from "./sync/format.js";
import { mergeDaily, newerPoint, recentDaily, MAX_BATCH_ITEMS } from "./sync/payload.js";

export const KEEP_DAYS = 90;
export const PAGE_ITEMS = 2500;
// Join codes skip look-alike characters (0/O, 1/I/L) so they survive being read aloud.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
}

function newToken() {
    return randomBytes(32).toString("hex");
}

function newJoinCode() {
    const bytes = randomBytes(8);
    let s = "";
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return s.slice(0, 4) + "-" + s.slice(4);
}

function cleanLabel(label) {
    if (typeof label !== "string") return null;
    const s = label.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
    return s || null;
}

export async function createGroup(query, name, label) {
    const groupName = cleanLabel(name);
    if (!groupName) throw new ApiError(400, "a group needs a name (1-40 characters)");
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = newJoinCode();
        const rows = await query(
            "insert into groups (name, join_code) values ($1, $2) on conflict (join_code) do nothing returning id",
            [groupName, code]);
        if (rows.length === 0) continue;
        const token = newToken();
        await query("insert into members (group_id, token_hash, label) values ($1, $2, $3)",
            [rows[0].id, hashToken(token), cleanLabel(label)]);
        return { group: groupName, joinCode: code, token };
    }
    throw new ApiError(500, "could not pick a free join code");
}

export async function joinGroup(query, code, label) {
    const norm = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (norm.length !== 8) throw new ApiError(400, "a join code is 8 characters, like ABCD-EFGH");
    const groups = await query("select id, name from groups where join_code = $1",
        [norm.slice(0, 4) + "-" + norm.slice(4)]);
    if (groups.length === 0) throw new ApiError(404, "no group has that join code");
    const token = newToken();
    await query("insert into members (group_id, token_hash, label) values ($1, $2, $3)",
        [groups[0].id, hashToken(token), cleanLabel(label)]);
    return { group: groups[0].name, token };
}

/** The member a bearer token belongs to, or an ApiError 401. */
export async function authenticate(query, token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        throw new ApiError(401, "missing or malformed token");
    }
    const rows = await query(
        `select m.id, m.group_id, m.label, g.name as group_name, g.join_code
           from members m join groups g on g.id = m.group_id
          where m.token_hash = $1`, [hashToken(token)]);
    if (rows.length === 0) throw new ApiError(401, "unknown token - join the group again");
    await query("update members set last_seen = now() where id = $1", [rows[0].id]);
    return rows[0];
}

export async function status(query, member) {
    const marketRows = () => query(
        `select i.market, count(*)::int as items, max(i.updated_at) as updated,
                (select count(*)::int from uploads u join members m on m.id = u.member_id
                  where m.group_id = $1 and u.market = i.market) as members
           from items i where i.group_id = $1 group by i.market order by i.market`, [member.group_id]);
    let markets = await marketRows();
    if (await mergeLegacyMarkets(query, member.group_id, markets.map((r) => r.market))) markets = await marketRows();
    const mine = await query(
        "select market, through_day, last_scan from uploads where member_id = $1 order by market", [member.id]);
    const count = await query("select count(*)::int as n from members where group_id = $1", [member.group_id]);
    return {
        v: WIRE,
        group: member.group_name,
        joinCode: member.join_code,
        members: Number(count[0].n),
        uploads: mine.map((r) => ({ market: r.market, throughDay: Number(r.through_day), lastScan: Number(r.last_scan) })),
        markets: markets.map((r) => ({
            market: r.market, items: Number(r.items), members: Number(r.members),
            updated: Math.floor(new Date(r.updated).getTime() / 1000),
            changed: new Date(r.updated).getTime(), // ms: companions compare it to their last download
        })),
    };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
const MAX_TEXT = 20000; // one item's daily text; 90 rows are ~2 KB

/** Checks a batch and decodes it; throws ApiError(400) on anything off. */
export function readBatch(body, now = Date.now() / 1000) {
    if (!body || typeof body !== "object") throw new ApiError(400, "body must be JSON");
    if (body.v !== WIRE) throw new ApiError(400, `wire version ${body.v} is not ${WIRE} - update the companion`);
    let lay;
    try { lay = layout(body.schema); } catch (e) { throw new ApiError(400, e.message); }
    if (!validMarket(body.market)) throw new ApiError(400, "bad market key");
    if (!Array.isArray(body.items) || body.items.length > MAX_BATCH_ITEMS) {
        throw new ApiError(400, `items must be a list of at most ${MAX_BATCH_ITEMS}`);
    }
    const today = dayIndex(now);
    const items = [];
    let maxDay = null;
    for (const it of body.items) {
        if (!Array.isArray(it) || it.length !== 3) throw new ApiError(400, "each item is [key, l, d]");
        const [key, l, d] = it;
        if (!validItemKey(key) || !validCodec(l, 200) || !validCodec(d, MAX_TEXT)) {
            throw new ApiError(400, `bad item ${String(key).slice(0, 40)}`);
        }
        // Plausibility: nothing from the future, no negative prices or quantities.
        let latest = "";
        if (l) {
            const p = decodeRow(l, lay.pWidth);
            const ok = p[P.T] !== null && p[P.T] <= now + 3600 && p[P.T] > now - 400 * 86400
                && [P.MIN, P.MKT, P.QTY, P.N].every((f) => p[f] === null || p[f] >= 0);
            if (ok) latest = l;
        }
        const rows = decodeDeltaRows(d, lay.dWidth, lay.dDelta).filter((r) =>
            r[D.DAY] !== null && r[D.DAY] <= today + 1 && r[D.DAY] > today - 400
            && [D.OPEN, D.HIGH, D.LOW, D.CLOSE, D.FLOOR, D.AVGQ, D.MAXQ].every((f) => r[f] === null || r[f] >= 0));
        for (const r of rows) if (maxDay === null || r[D.DAY] > maxDay) maxDay = r[D.DAY];
        if (latest || rows.length) items.push({ key, latest, rows });
    }
    return {
        schema: body.schema, lay, market: canonicalMarket(body.market), sentMarket: body.market, items, maxDay,
        lastScan: Number.isFinite(body.lastScan) ? Math.floor(body.lastScan) : 0,
        complete: body.complete === true,
        throughDay: Number.isInteger(body.throughDay) ? Math.min(body.throughDay, today + 1) : maxDay,
    };
}

export async function upload(query, member, body, now) {
    const b = readBatch(body, now);
    if (b.items.length > 0) {
        const keys = b.items.map((i) => i.key);
        const have = new Map();
        for (const r of await query(
            "select item_key, latest, daily from items where group_id = $1 and market = $2 and item_key = any($3::text[])",
            [member.group_id, b.market, keys])) {
            have.set(r.item_key, r);
        }
        const outKeys = [], outLatest = [], outDaily = [], outLastDay = [];
        for (const it of b.items) {
            const old = have.get(it.key);
            const oldRows = old ? decodeDeltaRows(old.daily, b.lay.dWidth, b.lay.dDelta) : [];
            const rows = mergeDaily(oldRows, it.rows, KEEP_DAYS);
            outKeys.push(it.key);
            outLatest.push(newerPoint(old ? old.latest : "", it.latest, b.lay.pWidth));
            outDaily.push(encodeDeltaRows(rows, b.lay.dWidth, b.lay.dDelta));
            outLastDay.push(rows.length ? rows[rows.length - 1][D.DAY] : null);
        }
        await query(
            `insert into items (group_id, market, item_key, latest, daily, last_day, updated_at)
             select $1, $2, u.k, u.l, u.d, u.ld, now()
               from unnest($3::text[], $4::text[], $5::text[], $6::int[]) as u(k, l, d, ld)
             on conflict (group_id, market, item_key) do update
                set latest = excluded.latest, daily = excluded.daily,
                    last_day = excluded.last_day, updated_at = now()`,
            [member.group_id, b.market, outKeys, outLatest, outDaily, outLastDay]);
    }
    // Only the last batch of an upload moves the member's mark: an upload cut off half
    // way is sent again in full next time, not skipped.
    // A companion reading a 0.3.0 SavedVariables looks its mark up under the key it sent,
    // so an old key gets the mark too - or it would send everything again every time.
    if (b.complete && b.throughDay !== null) {
        for (const market of new Set([b.market, b.sentMarket])) {
            await query(
                `insert into uploads (member_id, market, through_day, last_scan, updated_at)
                 values ($1, $2, $3, $4, now())
                 on conflict (member_id, market) do update
                    set through_day = greatest(uploads.through_day, excluded.through_day),
                        last_scan = greatest(uploads.last_scan, excluded.last_scan), updated_at = now()`,
                [member.id, market, b.throughDay, b.lastScan]);
        }
    }
    if (b.complete) await logUpload(query, member, b, body);
    return { ok: true, items: b.items.length, complete: b.complete };
}

// The scan log is a convenience: an upload must never fail because of it (for one, on a
// database where the upload_log table has not been created yet).
async function logUpload(query, member, b, body) {
    const total = Number.isInteger(body.totalItems) && body.totalItems >= 0 ? body.totalItems : b.items.length;
    try {
        // The same scan sent again (companions before 0.1.2 re-sent on every sync) is
        // not news: the data merge already ignored it, so does the log.
        if (b.lastScan) {
            const prev = await query(
                `select last_scan from upload_log where member_id = $1 and market = $2
                  order by created_at desc, id desc limit 1`, [member.id, b.market]);
            if (prev.length && Number(prev[0].last_scan) === b.lastScan) return;
        }
        await query(
            `insert into upload_log (group_id, member_id, label, market, items, full_upload, last_scan)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [member.group_id, member.id, member.label || null, b.market, Math.min(total, 1e7),
                body.full === true, b.lastScan]);
        // Keep the newest 500 per group.
        await query(
            `delete from upload_log where group_id = $1 and id not in
               (select id from upload_log where group_id = $1 order by created_at desc, id desc limit 500)`,
            [member.group_id]);
    } catch (e) {
        console.error("upload_log:", e.message);
    }
}

// ---------------------------------------------------------------------------
// Scan log page (public/index.html): anyone with the join code may read it, as anyone
// with it may join.
// ---------------------------------------------------------------------------
export const LOG_ROWS = 100;

export async function scanLog(query, code) {
    const norm = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (norm.length !== 8) throw new ApiError(400, "a join code is 8 characters, like ABCD-EFGH");
    const groups = await query("select id, name, created_at from groups where join_code = $1",
        [norm.slice(0, 4) + "-" + norm.slice(4)]);
    if (groups.length === 0) throw new ApiError(404, "no group has that join code");
    const g = groups[0];
    const members = await query(
        `select coalesce(label, '') as label, created_at, last_seen from members where group_id = $1
          order by created_at`, [g.id]);
    const marketRows = () => query(
        `select market, count(*)::int as items, max(updated_at) as updated
           from items where group_id = $1 group by market order by market`, [g.id]);
    let markets = await marketRows();
    if (await mergeLegacyMarkets(query, g.id, markets.map((r) => r.market))) markets = await marketRows();
    let scans = [];
    let logReady = true;
    try {
        scans = await query(
            `select l.created_at, coalesce(l.label, '') as label, l.market, l.items, l.full_upload, l.last_scan
               from upload_log l where l.group_id = $1
              order by l.created_at desc, l.id desc limit $2`, [g.id, LOG_ROWS]);
    } catch {
        logReady = false; // upload_log not created yet: see schema.sql
    }
    const secs = (t) => (t ? Math.floor(new Date(t).getTime() / 1000) : null);
    return {
        group: g.name,
        created: secs(g.created_at),
        logReady,
        members: members.map((m) => ({ label: m.label, joined: secs(m.created_at), lastSeen: secs(m.last_seen) })),
        markets: markets.map((m) => ({ market: m.market, items: Number(m.items), updated: secs(m.updated) })),
        scans: scans.map((s) => ({
            time: secs(s.created_at), label: s.label, market: s.market, items: Number(s.items),
            full: !!s.full_upload, lastScan: Number(s.last_scan) || null,
        })),
    };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
export async function download(query, member, params, now = Date.now() / 1000) {
    if (!validMarket(params.market)) throw new ApiError(400, "bad market key");
    const market = canonicalMarket(params.market);
    const schema = Number(params.schema || 3);
    try { layout(schema); } catch (e) { throw new ApiError(400, e.message); }
    const days = Math.min(KEEP_DAYS, Math.max(1, Number(params.days) || 30));
    const after = typeof params.after === "string" ? params.after : "";
    const fromDay = dayIndex(now) - days + 1;
    const rows = await query(
        `select item_key, latest, daily from items
          where group_id = $1 and market = $2 and item_key > $3
          order by item_key limit $4`,
        [member.group_id, market, after, PAGE_ITEMS]);
    // An item nobody has seen in the window is left out: no daily rows in it, and its
    // newest point older than its first day.
    const lay = layout(schema);
    const items = [];
    for (const r of rows) {
        const d = recentDaily(r.daily, schema, fromDay);
        const t = r.latest ? decodeRow(r.latest, lay.pWidth)[P.T] : null;
        const fresh = t !== null && dayIndex(t) >= fromDay;
        if (d || fresh) items.push([r.item_key, fresh || d ? r.latest : "", d]);
    }
    const meta = await query(
        `select (select count(*)::int from uploads u join members m on m.id = u.member_id
                  where m.group_id = $1 and u.market = $2) as members,
                (select max(updated_at) from items where group_id = $1 and market = $2) as updated`,
        [member.group_id, market]);
    return {
        v: WIRE,
        schema,
        market,
        group: member.group_name,
        members: Number(meta[0].members) || 0,
        updated: meta[0].updated ? Math.floor(new Date(meta[0].updated).getTime() / 1000) : 0,
        changed: meta[0].updated ? new Date(meta[0].updated).getTime() : 0,
        items,
        next: rows.length === PAGE_ITEMS ? rows[rows.length - 1].item_key : null,
    };
}

// ---------------------------------------------------------------------------
// Market keys with the server's realm number
// ---------------------------------------------------------------------------
// Addon 0.3.0 and earlier keyed markets "US-CAMWOWUS2Realm6PvP-Horde", and a guild-mate
// on the same auction house got "...Realm2PvP...": one market stored twice. Whatever a
// group still has under such a key is merged into the canonical one the first time its
// markets are listed (status, the scan log page). Each page is merged then deleted, and
// the merge is idempotent, so a request cut off part-way leaves nothing wrong: the next
// one carries on.

/** Moves one group's items from market `from` into `to`, merging where both have them. */
export async function mergeMarket(query, groupId, from, to, schema = 3) {
    const lay = layout(schema);
    let moved = 0;
    for (;;) {
        const rows = await query(
            `select item_key, latest, daily from items where group_id = $1 and market = $2
              order by item_key limit $3`, [groupId, from, PAGE_ITEMS]);
        if (rows.length === 0) break;
        const keys = rows.map((r) => r.item_key);
        const have = new Map();
        for (const r of await query(
            "select item_key, latest, daily from items where group_id = $1 and market = $2 and item_key = any($3::text[])",
            [groupId, to, keys])) {
            have.set(r.item_key, r);
        }
        const outLatest = [], outDaily = [], outLastDay = [];
        for (const r of rows) {
            const old = have.get(r.item_key);
            const merged = mergeDaily(old ? decodeDeltaRows(old.daily, lay.dWidth, lay.dDelta) : [],
                decodeDeltaRows(r.daily, lay.dWidth, lay.dDelta), KEEP_DAYS);
            outLatest.push(newerPoint(old ? old.latest : "", r.latest, lay.pWidth));
            outDaily.push(encodeDeltaRows(merged, lay.dWidth, lay.dDelta));
            outLastDay.push(merged.length ? merged[merged.length - 1][D.DAY] : null);
        }
        await query(
            `insert into items (group_id, market, item_key, latest, daily, last_day, updated_at)
             select $1, $2, u.k, u.l, u.d, u.ld, now()
               from unnest($3::text[], $4::text[], $5::text[], $6::int[]) as u(k, l, d, ld)
             on conflict (group_id, market, item_key) do update
                set latest = excluded.latest, daily = excluded.daily,
                    last_day = excluded.last_day, updated_at = now()`,
            [groupId, to, keys, outLatest, outDaily, outLastDay]);
        await query("delete from items where group_id = $1 and market = $2 and item_key = any($3::text[])",
            [groupId, from, keys]);
        moved += rows.length;
    }
    // Members' marks follow. The old row stays too: see upload().
    await query(
        `insert into uploads (member_id, market, through_day, last_scan, updated_at)
         select u.member_id, $2, u.through_day, u.last_scan, now() from uploads u
          where u.market = $1 and u.member_id in (select id from members where group_id = $3)
         on conflict (member_id, market) do update
            set through_day = greatest(uploads.through_day, excluded.through_day),
                last_scan = greatest(uploads.last_scan, excluded.last_scan), updated_at = now()`,
        [from, to, groupId]);
    try {
        await query("update upload_log set market = $3 where group_id = $1 and market = $2", [groupId, from, to]);
    } catch (e) {
        console.error("upload_log:", e.message); // table not created yet: nothing to rename
    }
    return moved;
}

/** Merges every market in `markets` that has a realm number; true if any was. */
export async function mergeLegacyMarkets(query, groupId, markets) {
    let any = false;
    for (const from of markets) {
        const to = canonicalMarket(from);
        if (to === from) continue;
        await mergeMarket(query, groupId, from, to);
        any = true;
    }
    return any;
}

/** Leaving deletes the member; what they uploaded stays merged into the guild's data. */
export async function leave(query, member) {
    await query("delete from members where id = $1", [member.id]);
    return { ok: true };
}
