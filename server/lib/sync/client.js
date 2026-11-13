// The companion's work, independent of where it runs: the command line (Node) and the
// Overwolf app both call these with an `env` that supplies files and the network.
//
//   env = {
//     readText(path)        -> Promise<string>   UTF-8
//     writeText(path, text) -> Promise<void>     UTF-8, creating missing folders
//     exists(path)          -> Promise<boolean>
//     listDir(path)         -> Promise<string[]> entry names, [] if missing
//     join(...parts)        -> string            Windows-style path join
//     fetch                                      the platform's fetch
//   }
//   cfg = { server, token, wow }   wow = the WoW: Forever client folder (_forever_)
//
// Reads SavedVariables, never writes them: the game owns that file and rewrites it on
// logout. Writes only Interface/AddOns/AuctionLens_Crowd, which AuctionLens reads.
//
// Text is UTF-8 end to end, so a realm name with an accent is the same market key
// whichever companion uploaded it.

import { parseSavedVariables } from "./savedvars.js";
import { decodeDeltaRows } from "./codec.js";
import { D, layout } from "./format.js";
import { marketsIn, buildBatches, renderCrowdLua, renderCrowdToc } from "./payload.js";

export const CROWD_ADDON = "AuctionLens_Crowd";
/** The guild server everyone uses unless they type another. */
export const DEFAULT_SERVER = "https://auctionlens-project-server.vercel.app";
export const DEFAULT_DAYS = 30;

export class SyncError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export async function api(env, cfg, method, path, body, extraHeaders = {}) {
    if (!cfg.server) throw new SyncError("no server set - join or create a group first");
    let res;
    try {
        res = await env.fetch(cfg.server.replace(/\/+$/, "") + "/api/" + path, {
            method,
            headers: {
                ...(body ? { "content-type": "application/json" } : {}),
                ...(cfg.token ? { authorization: "Bearer " + cfg.token } : {}),
                ...extraHeaders,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (e) {
        throw new SyncError(`cannot reach ${cfg.server}: ${e.message || e}`);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new SyncError(`${path}: ${res.status} ${data.error || ""}`.trim(), res.status);
    return data;
}

export async function createGroup(env, server, name, label, secret) {
    const extra = secret ? { "x-create-secret": secret } : {};
    return api(env, { server }, "POST", "group", { name, label }, extra);
}

export async function joinGroup(env, server, code, label) {
    return api(env, { server }, "POST", "join", { code, label });
}

export function status(env, cfg) {
    return api(env, cfg, "GET", "status");
}

export function leave(env, cfg) {
    return api(env, cfg, "POST", "leave");
}

/** Every AuctionLens SavedVariables file under a WoW client folder, one per account. */
export async function findSavedVariables(env, wow) {
    if (!wow) return [];
    const accounts = env.join(wow, "WTF", "Account");
    const out = [];
    for (const acct of await env.listDir(accounts)) {
        const f = env.join(accounts, acct, "SavedVariables", "AuctionLens.lua");
        if (await env.exists(f)) out.push(f);
    }
    return out;
}

/** True when the folder looks like a WoW client: it has WTF\Account or Interface\AddOns. */
export async function looksLikeWow(env, wow) {
    if (!wow) return false;
    return (await env.exists(env.join(wow, "WTF", "Account")))
        || (await env.exists(env.join(wow, "Interface", "AddOns")));
}

async function readDb(env, file) {
    const parsed = parseSavedVariables(await env.readText(file));
    const db = parsed.AuctionLensDB;
    if (!db || typeof db !== "object") throw new SyncError(`${file}: no AuctionLensDB in it`);
    return db;
}

async function svFiles(env, cfg, opt) {
    if (opt.sv) return [opt.sv];
    if (!cfg.wow) throw new SyncError("choose the WoW: Forever folder first");
    const files = await findSavedVariables(env, cfg.wow);
    if (files.length === 0) {
        throw new SyncError(`no AuctionLens data under ${cfg.wow}\\WTF\\Account - log in once with AuctionLens enabled`);
    }
    return files;
}

function newestDay(entry, schema) {
    const lay = layout(schema);
    let max = null;
    for (const rec of Object.values(entry.items)) {
        if (!rec || typeof rec.d !== "string" || !rec.d) continue;
        const rows = decodeDeltaRows(rec.d, lay.dWidth, lay.dDelta);
        const day = rows.length ? rows[rows.length - 1][D.DAY] : null;
        if (day !== null && (max === null || day > max)) max = day;
    }
    return max;
}

/**
 * Sends what is new since this member's last complete upload, per market.
 * Returns { items, markets: [{ market, items, batches, full }] }.
 */
export async function upload(env, cfg, opt = {}, log = () => {}) {
    const st = await status(env, cfg);
    const through = new Map(st.uploads.map((u) => [u.market, u.throughDay]));
    const summary = { items: 0, markets: [] };
    for (const file of await svFiles(env, cfg, opt)) {
        const db = await readDb(env, file);
        const schema = Number(db.schema);
        try { layout(schema); } catch (e) { throw new SyncError(`${e.message} - update the companion`); }
        for (const entry of marketsIn(db)) {
            // Yesterday again: a day still running at the last upload was not finished.
            const prev = through.get(entry.market);
            const since = prev === undefined ? undefined : prev - 1;
            const batches = buildBatches(schema, entry, since);
            if (batches.length === 0) {
                log(`${entry.market}: nothing new`);
                continue;
            }
            const throughDay = newestDay(entry, schema);
            // For the group's scan log: the whole upload's size, and whether it was the
            // first (full history) one.
            const totalItems = batches.reduce((n, b) => n + b.items.length, 0);
            const full = since === undefined;
            let sent = 0;
            for (let i = 0; i < batches.length; i++) {
                const last = i === batches.length - 1;
                const body = last ? { ...batches[i], complete: true, throughDay, totalItems, full } : batches[i];
                const r = await api(env, cfg, "POST", "upload", body);
                sent += r.items;
                log(`${entry.market}: sent ${i + 1}/${batches.length}`
                    + (since === undefined ? " (first upload: full history)" : ""));
            }
            summary.items += sent;
            summary.markets.push({ market: entry.market, items: sent, batches: batches.length, full: since === undefined });
            // A second account on the same market sends from the same mark.
            through.set(entry.market, throughDay);
        }
    }
    return summary;
}

async function interfaceVersion(env, wow) {
    try {
        const toc = await env.readText(env.join(wow, "Interface", "AddOns", "AuctionLens", "AuctionLens.toc"));
        const m = /^## Interface:\s*(\d+)/m.exec(toc);
        if (m) return m[1];
    } catch { /* not installed here: the default will do */ }
    return "16001";
}

/**
 * Fetches the guild's data for every market in the local SavedVariables and writes the
 * AuctionLens_Crowd addon. `opt.out` writes to another folder instead (tests).
 * Returns the data written, plus { dir, items }.
 */
export async function download(env, cfg, opt = {}, log = () => {}) {
    const days = Number(opt.days) || DEFAULT_DAYS;
    const markets = new Set();
    let schema = 3;
    for (const file of await svFiles(env, cfg, opt)) {
        const db = await readDb(env, file);
        schema = Number(db.schema) || schema;
        for (const m of marketsIn(db)) markets.add(m.market);
    }
    const data = { group: "", generated: Math.floor(Date.now() / 1000), schema, markets: {} };
    let total = 0;
    for (const market of markets) {
        const items = [];
        let after = "";
        let page;
        do {
            const q = new URLSearchParams({ market, days: String(days), schema: String(schema), after });
            page = await api(env, cfg, "GET", "download?" + q);
            items.push(...page.items);
            after = page.next;
        } while (after);
        data.group = page.group;
        if (items.length) data.markets[market] = { updated: page.updated, members: page.members, items };
        total += items.length;
        log(`${market}: ${items.length} items from ${page.members} member(s)`);
    }
    const dir = opt.out || env.join(cfg.wow, "Interface", "AddOns", CROWD_ADDON);
    await env.writeText(env.join(dir, CROWD_ADDON + ".toc"), renderCrowdToc(await interfaceVersion(env, cfg.wow || dir)));
    await env.writeText(env.join(dir, "Data.lua"), renderCrowdLua(data));
    log(`wrote ${dir}`);
    return { ...data, dir, items: total };
}

/** Upload, then download: one complete sync. */
export async function sync(env, cfg, opt = {}, log = () => {}) {
    const up = await upload(env, cfg, opt, log);
    const down = await download(env, cfg, opt, log);
    return { uploaded: up.items, downloaded: down.items, group: down.group, dir: down.dir, markets: up.markets };
}
