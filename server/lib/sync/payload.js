// What moves between the addon's SavedVariables, the server and the guild data addon.
//
// Upload batch (companion -> server), JSON:
//   { v: 1, schema: 3, market: "US-Realm-Horde", lastScan: 1794586803,
//     items: [ [itemKey, l, d], ... ] }
//   l  the item's newest point, absolute (rec.l as stored), or "" if unchanged
//   d  daily rows from the requested day on, delta-coded afresh (a slice of rec.d)
//
// Download page (server -> companion) has the same item triples, merged across the
// guild. The companion writes them into AuctionLens_Crowd/Data.lua, which the addon
// reads with its own Codec - so everything stays in the addon's storage format.

import { decodeDeltaRows, encodeDeltaRows, decodeRow } from "./codec.js";
import { D, P, WIRE, layout, dayIndex } from "./format.js";

/** Vercel refuses request bodies over 4.5 MB; stay well under it. */
export const MAX_BATCH_BYTES = 3_000_000;
export const MAX_BATCH_ITEMS = 5000;

/** The markets in a parsed AuctionLensDB, newest scan first. */
export function marketsIn(db) {
    const out = [];
    for (const [market, m] of Object.entries((db && db.markets) || {})) {
        if (!m || typeof m !== "object" || !m.items) continue;
        const lastScan = (m.meta && m.meta.lastScan) || m.lastScan || 0;
        out.push({ market, lastScan, items: m.items });
    }
    out.sort((a, b) => b.lastScan - a.lastScan);
    return out;
}

/**
 * Upload batches for one market. `sinceDay` (from the server's status) limits the
 * daily rows to that day and later, and drops newest points older than it; undefined
 * sends everything (the first upload, which is the history backfill).
 */
export function buildBatches(schema, entry, sinceDay) {
    const lay = layout(schema);
    const batches = [];
    let items = [];
    let bytes = 0;
    const flush = () => {
        if (items.length === 0) return;
        batches.push({ v: WIRE, schema, market: entry.market, lastScan: entry.lastScan, items });
        items = [];
        bytes = 0;
    };
    const keys = Object.keys(entry.items).sort();
    for (const key of keys) {
        const rec = entry.items[key];
        if (!rec || typeof rec !== "object") continue;
        let d = "";
        if (typeof rec.d === "string" && rec.d !== "") {
            if (sinceDay === undefined) {
                d = rec.d;
            } else {
                const rows = decodeDeltaRows(rec.d, lay.dWidth, lay.dDelta).filter((r) => r[D.DAY] >= sinceDay);
                d = encodeDeltaRows(rows, lay.dWidth, lay.dDelta);
            }
        }
        let l = typeof rec.l === "string" ? rec.l : "";
        if (l && sinceDay !== undefined) {
            const t = decodeRow(l, lay.pWidth)[P.T];
            if (t === null || dayIndex(t) < sinceDay) l = "";
        }
        if (!l && !d) continue;
        const size = key.length + l.length + d.length + 12;
        if (items.length >= MAX_BATCH_ITEMS || (bytes + size > MAX_BATCH_BYTES && items.length > 0)) flush();
        items.push([key, l, d]);
        bytes += size;
    }
    flush();
    return batches;
}

// ---------------------------------------------------------------------------
// Merging what two players saw
//
// Two guild members on one realm and faction see the same auction house, so their
// rows for one day are two samples of one market, not two markets: extremes combine
// (lowest low, highest high), and everything that is a reading of the day - open,
// close, average quantity - comes from the observer who scanned it most. Sold units
// take the larger estimate instead of the sum, which would count every sale twice.
//
// Merging is idempotent (a row merged with itself is unchanged) so an upload that is
// sent twice, or a day sent again while it is still going, does no harm.
// ---------------------------------------------------------------------------
function minOf(a, b) { return a === null ? b : b === null ? a : Math.min(a, b); }
function maxOf(a, b) { return a === null ? b : b === null ? a : Math.max(a, b); }

export function mergeDay(a, b) {
    const sa = a[D.SCANS] || 0;
    const sb = b[D.SCANS] || 0;
    const main = sb >= sa ? b : a;
    const row = main.slice();
    row[D.HIGH] = maxOf(a[D.HIGH], b[D.HIGH]);
    row[D.LOW] = minOf(a[D.LOW], b[D.LOW]);
    row[D.FLOOR] = minOf(a[D.FLOOR], b[D.FLOOR]);
    row[D.MAXQ] = maxOf(a[D.MAXQ], b[D.MAXQ]);
    row[D.SOLD] = maxOf(a[D.SOLD], b[D.SOLD]);
    row[D.SCANS] = Math.max(sa, sb) || main[D.SCANS];
    return row;
}

/** Day rows from both sides, merged per day, oldest first, the newest `keepDays` kept. */
export function mergeDaily(older, newer, keepDays = 90) {
    const byDay = new Map();
    for (const r of older) byDay.set(r[D.DAY], r);
    for (const r of newer) {
        const have = byDay.get(r[D.DAY]);
        byDay.set(r[D.DAY], have ? mergeDay(have, r) : r);
    }
    const rows = [...byDay.values()].sort((x, y) => x[D.DAY] - y[D.DAY]);
    return rows.length > keepDays ? rows.slice(rows.length - keepDays) : rows;
}

/** The newer of two newest points (absolute rows), by scan time. */
export function newerPoint(a, b, pWidth) {
    if (!a) return b || "";
    if (!b) return a;
    const ta = decodeRow(a, pWidth)[P.T] || 0;
    const tb = decodeRow(b, pWidth)[P.T] || 0;
    return tb >= ta ? b : a;
}

/** Daily text trimmed to the last `days` days before `today`'s end. */
export function recentDaily(d, schema, fromDay) {
    if (!d) return "";
    const lay = layout(schema);
    const rows = decodeDeltaRows(d, lay.dWidth, lay.dDelta).filter((r) => r[D.DAY] >= fromDay);
    return encodeDeltaRows(rows, lay.dWidth, lay.dDelta);
}

// ---------------------------------------------------------------------------
// The guild data addon
// ---------------------------------------------------------------------------
/** A Lua string literal. Characters over 127 pass through: the file is written as UTF-8. */
export function luaString(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 34) out += '\\"';
        else if (c === 92) out += "\\\\";
        else if (c === 10) out += "\\n";
        else if (c < 32 || c === 127) out += "\\" + String(c).padStart(3, "0");
        else out += s[i];
    }
    return out + '"';
}

// Lua 5.1 allows at most 2^18 constants in one function, and a market is ~33,000 items
// with three strings each. Each slice of items is assigned inside its own function.
const ITEMS_PER_CHUNK = 4000;

/**
 * Data.lua for AuctionLens_Crowd.
 *   data = { group, generated, schema, markets: { [market]: { updated, items: [[key, l, d]] } } }
 * Read by AuctionLens/Data/Crowd.lua, which owns the meaning of every field.
 */
export function renderCrowdLua(data) {
    const lines = [];
    lines.push("-- Written by the AuctionLens companion. Do not edit: it is replaced on every sync.");
    lines.push("AuctionLensCrowdData = {");
    lines.push(`    v = ${WIRE},`);
    lines.push(`    schema = ${Number(data.schema) || 0},`);
    lines.push(`    group = ${luaString(String(data.group || ""))},`);
    lines.push(`    generated = ${Math.floor(Number(data.generated) || 0)},`);
    lines.push("    markets = {},");
    lines.push("}");
    for (const [market, m] of Object.entries(data.markets || {})) {
        lines.push(`AuctionLensCrowdData.markets[${luaString(market)}] = { updated = ${Math.floor(Number(m.updated) || 0)}, `
            + `members = ${Math.floor(Number(m.members) || 0)}, items = {} }`);
        const items = m.items || [];
        for (let i = 0; i < items.length; i += ITEMS_PER_CHUNK) {
            lines.push("do (function(t)");
            for (const [key, l, d] of items.slice(i, i + ITEMS_PER_CHUNK)) {
                lines.push(`t[${luaString(key)}]={${luaString(l || "")},${luaString(d || "")}}`);
            }
            lines.push(`end)(AuctionLensCrowdData.markets[${luaString(market)}].items) end`);
        }
    }
    return lines.join("\n") + "\n";
}

export function renderCrowdToc(interfaceVersion = "16001") {
    return [
        `## Interface: ${interfaceVersion}`,
        "## Title: AuctionLens Guild Data",
        "## Notes: Prices shared by your guild, written by the AuctionLens companion. Read-only; AuctionLens shows it.",
        "## Author: AuctionLens companion",
        "",
        "Data.lua",
        "",
    ].join("\n");
}
