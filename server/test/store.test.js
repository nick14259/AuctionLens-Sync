// The API against a real Postgres engine (PGlite), through the same handlers Vercel runs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { setQuery } from "../lib/db.js";
import { encodeDeltaRows, decodeDeltaRows, encodeRow } from "../lib/sync/codec.js";
import { layout, D } from "../lib/sync/format.js";
import { PAGE_ITEMS } from "../lib/store.js";
import * as group from "../api/group.js";
import * as join from "../api/join.js";
import * as status from "../api/status.js";
import * as upload from "../api/upload.js";
import * as download from "../api/download.js";
import * as leave from "../api/leave.js";
import * as scanlog from "../api/log.js";

const lay = layout(3);
const NOW = Math.floor(Date.now() / 1000);
const TODAY = Math.floor(NOW / 86400);
const MK = "US-Test-Horde";
let pg;

before(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    setQuery(async (text, params = []) => (await pg.query(text, params)).rows);
});
after(async () => { await pg.close(); });

async function call(mod, method, path, { body, token, headers = {} } = {}) {
    const req = new Request("http://test/api/" + path, {
        method,
        headers: {
            ...(token ? { authorization: "Bearer " + token } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const res = await mod[method](req);
    return { status: res.status, body: await res.json(), headers: res.headers };
}

function daily(rows) { return encodeDeltaRows(rows, 10, lay.dDelta); }
function point(t, min) { return encodeRow([t, min, min + 5, 3, 2, null, 3], 7); }
function batch(items, extra = {}) { return { v: 1, schema: 3, market: MK, lastScan: NOW - 60, items, ...extra }; }

test("a guild: create, join, upload from two members, read back merged", async () => {
    const created = await call(group, "POST", "group", { body: { name: "Lens Guild", label: "founder" } });
    assert.equal(created.status, 200);
    assert.match(created.body.joinCode, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.equal(created.headers.get("access-control-allow-origin"), "*", "the Overwolf app can call it");
    const a = created.body.token;

    const code = created.body.joinCode.toLowerCase().replace("-", " ");
    const joined = await call(join, "POST", "join", { body: { code } });
    assert.equal(joined.status, 200, "codes are forgiving about case and separators");
    assert.equal(joined.body.group, "Lens Guild");
    const b = joined.body.token;

    // Member A: two days of item 100, one of item 200.
    let r = await call(upload, "POST", "upload", { token: a, body: batch([
        ["100", point(NOW - 3600, 50), daily([[TODAY - 1, 60, 70, 50, 65, 48, 5, 6, 2, 4], [TODAY, 65, 80, 55, 70, 55, 6, 8, 1, 3]])],
        ["200", point(NOW - 3600, 900), daily([[TODAY, 900, 900, 900, 900, 900, 1, 1, null, 1]])],
    ], { complete: true, throughDay: TODAY }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.items, 2);

    // Member B saw item 100 today too, more often and lower, and later.
    r = await call(upload, "POST", "upload", { token: b, body: batch([
        ["100", point(NOW - 60, 40), daily([[TODAY, 66, 75, 52, 68, 40, 7, 9, 3, 9]])],
    ], { complete: true, throughDay: TODAY }) });
    assert.equal(r.status, 200);

    const st = await call(status, "GET", "status", { token: a });
    assert.equal(st.body.group, "Lens Guild");
    assert.equal(st.body.members, 2);
    assert.deepEqual(st.body.uploads.map((u) => [u.market, u.throughDay]), [[MK, TODAY]]);
    assert.equal(st.body.markets[0].items, 2);
    assert.equal(st.body.markets[0].members, 2);

    const dl = await call(download, "GET", `download?market=${MK}&days=30`, { token: b });
    assert.equal(dl.status, 200);
    assert.equal(dl.body.next, null);
    const item = Object.fromEntries(dl.body.items.map(([k, l, d]) => [k, { l, d }]));
    assert.equal(item["100"].l, point(NOW - 60, 40), "the newest point, whoever saw it");
    const rows = decodeDeltaRows(item["100"].d, 10, lay.dDelta);
    assert.equal(rows.length, 2);
    const today = rows[1];
    assert.equal(today[D.LOW], 52);
    assert.equal(today[D.HIGH], 80);
    assert.equal(today[D.FLOOR], 40);
    assert.equal(today[D.CLOSE], 68, "B scanned more: its close");
    assert.equal(today[D.SCANS], 9);
    assert.ok(item["200"]);

    const fewer = await call(download, "GET", `download?market=${MK}&days=1`, { token: b });
    const r100 = fewer.body.items.find((i) => i[0] === "100");
    assert.equal(decodeDeltaRows(r100[2], 10, lay.dDelta).length, 1, "days limits the history sent");
});

test("only the last batch of an upload moves the member's mark", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Marks" } });
    await call(upload, "POST", "upload", { token: g.token, body: batch([["300", point(NOW - 60, 5), ""]]) });
    let st = await call(status, "GET", "status", { token: g.token });
    assert.deepEqual(st.body.uploads, [], "an upload cut off half way leaves no mark");
    await call(upload, "POST", "upload", { token: g.token, body: batch([], { complete: true, throughDay: TODAY }) });
    st = await call(status, "GET", "status", { token: g.token });
    assert.equal(st.body.uploads[0].throughDay, TODAY);
});

test("groups do not see each other", async () => {
    const { body: g1 } = await call(group, "POST", "group", { body: { name: "One" } });
    const { body: g2 } = await call(group, "POST", "group", { body: { name: "Two" } });
    await call(upload, "POST", "upload", { token: g1.token, body: batch([["400", point(NOW - 60, 7), ""]]) });
    const dl = await call(download, "GET", `download?market=${MK}`, { token: g2.token });
    assert.deepEqual(dl.body.items, []);
});

test("leaves out items nobody has seen in the window", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Stale" } });
    await call(upload, "POST", "upload", { token: g.token, body: batch([
        ["700", point(NOW - 86400 * 40, 5), daily([[TODAY - 40, 5, 5, 5, 5, 5, 1, 1, null, 1]])],
        ["701", point(NOW - 60, 6), ""],
    ]) });
    const dl = await call(download, "GET", `download?market=${MK}&days=30`, { token: g.token });
    assert.deepEqual(dl.body.items.map((i) => i[0]), ["701"]);
    const all = await call(download, "GET", `download?market=${MK}&days=90`, { token: g.token });
    assert.deepEqual(all.body.items.map((i) => i[0]), ["700", "701"]);
});

test("pages a big market", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Big" } });
    const items = [];
    for (let i = 0; i < PAGE_ITEMS + 5; i++) items.push([String(10000 + i), point(NOW - 60, 1 + i), ""]);
    const r = await call(upload, "POST", "upload", { token: g.token, body: batch(items) });
    assert.equal(r.body.items, PAGE_ITEMS + 5);
    const p1 = await call(download, "GET", `download?market=${MK}`, { token: g.token });
    assert.equal(p1.body.items.length, PAGE_ITEMS);
    assert.ok(p1.body.next);
    const p2 = await call(download, "GET", `download?market=${MK}&after=${p1.body.next}`, { token: g.token });
    assert.equal(p2.body.items.length, 5);
    assert.equal(p2.body.next, null);
});

test("refuses what it should", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Strict" } });
    assert.equal((await call(status, "GET", "status")).status, 401);
    assert.equal((await call(status, "GET", "status", { token: "f".repeat(64) })).status, 401);
    assert.equal((await call(group, "POST", "group", { body: { name: "  " } })).status, 400);
    assert.equal((await call(join, "POST", "join", { body: { code: "ZZZZ-ZZZZ" } })).status, 404);
    const bad = async (b) => (await call(upload, "POST", "upload", { token: g.token, body: b })).status;
    assert.equal(await bad(batch([], { v: 9 })), 400, "unknown wire version");
    assert.equal(await bad(batch([], { schema: 99 })), 400, "unknown storage schema");
    assert.equal(await bad(batch([["1); drop table items; --", "", ""]])), 400);
    assert.equal(await bad(batch([["1", "<script>", ""]])), 400);
    // Implausible data is dropped, not stored.
    const r = await call(upload, "POST", "upload", { token: g.token, body: batch([
        ["500", point(NOW + 86400 * 5, 9), ""],
        ["501", "", daily([[TODAY + 30, 1, 1, 1, 1, 1, 1, 1, null, 1]])],
    ]) });
    assert.equal(r.body.items, 0);
});

test("a deployment with CREATE_SECRET only makes groups for whoever has it", async () => {
    process.env.CREATE_SECRET = "s3cret";
    try {
        assert.equal((await call(group, "POST", "group", { body: { name: "X" } })).status, 403);
        const ok = await call(group, "POST", "group", { body: { name: "X" }, headers: { "x-create-secret": "s3cret" } });
        assert.equal(ok.status, 200);
    } finally {
        delete process.env.CREATE_SECRET;
    }
});

test("the scan log shows each finished upload to whoever has the join code", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Loggers", label: "Founder" } });
    const { body: j } = await call(join, "POST", "join", { body: { code: g.joinCode } });
    // A two-batch upload: logged once, when it completes, with the whole size.
    await call(upload, "POST", "upload", { token: g.token, body: batch([["800", point(NOW - 60, 5), ""]]) });
    let log = await call(scanlog, "POST", "log", { body: { code: g.joinCode } });
    assert.equal(log.body.scans.length, 0, "not until the upload is complete");
    await call(upload, "POST", "upload", { token: g.token, body: batch([["801", point(NOW - 60, 6), ""]],
        { complete: true, throughDay: TODAY, totalItems: 2, full: true }) });
    await call(upload, "POST", "upload", { token: j.token, body: batch([["800", point(NOW - 30, 4), ""]],
        { complete: true, throughDay: TODAY }) });

    log = await call(scanlog, "POST", "log", { body: { code: g.joinCode.toLowerCase() } });
    assert.equal(log.status, 200);
    assert.equal(log.body.group, "Loggers");
    assert.equal(log.body.logReady, true);
    assert.equal(log.body.members.length, 2);
    assert.deepEqual(log.body.members.map((m) => m.label), ["Founder", ""]);
    assert.deepEqual(log.body.markets, [{ market: MK, items: 2, updated: log.body.markets[0].updated }]);
    assert.equal(log.body.scans.length, 2);
    const [newest, oldest] = log.body.scans;
    assert.equal(newest.label, "", "the member who gave no name");
    assert.equal(newest.items, 1, "an older companion without totalItems: the batch's count");
    assert.equal(newest.full, false);
    assert.equal(oldest.label, "Founder");
    assert.equal(oldest.items, 2);
    assert.equal(oldest.full, true);
    assert.equal(oldest.lastScan, NOW - 60);
    assert.ok(!JSON.stringify(log.body).includes(g.token), "no tokens on the page");

    assert.equal((await call(scanlog, "POST", "log", { body: { code: "ZZZZ-ZZZZ" } })).status, 404);
    assert.equal((await call(scanlog, "POST", "log", { body: { code: "nope" } })).status, 400);

    // The same scan sent again (as companions before 0.1.2 did on every sync): not logged.
    await call(upload, "POST", "upload", { token: j.token, body: batch([["800", point(NOW - 30, 4), ""]],
        { complete: true, throughDay: TODAY }) });
    log = await call(scanlog, "POST", "log", { body: { code: g.joinCode } });
    assert.equal(log.body.scans.length, 2, "a repeat of the same scan is not news");
    // A newer scan is.
    await call(upload, "POST", "upload", { token: j.token, body: batch([["800", point(NOW - 10, 3), ""]],
        { complete: true, throughDay: TODAY, lastScan: NOW - 10 }) });
    log = await call(scanlog, "POST", "log", { body: { code: g.joinCode } });
    assert.equal(log.body.scans.length, 3);
});

test("leaving forgets the member", async () => {
    const { body: g } = await call(group, "POST", "group", { body: { name: "Leavers" } });
    assert.equal((await call(leave, "POST", "leave", { token: g.token })).status, 200);
    assert.equal((await call(status, "GET", "status", { token: g.token })).status, 401);
});

// Last: it drops a table. A server whose database predates the scan log keeps working.
test("without the upload_log table, uploads still work and the page says what to do", async () => {
    await pg.exec("drop table upload_log");
    const { body: g } = await call(group, "POST", "group", { body: { name: "Old database" } });
    const r = await call(upload, "POST", "upload", { token: g.token, body: batch([["900", point(NOW - 60, 5), ""]],
        { complete: true, throughDay: TODAY }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.items, 1);
    const log = await call(scanlog, "POST", "log", { body: { code: g.joinCode } });
    assert.equal(log.status, 200);
    assert.equal(log.body.logReady, false);
    assert.deepEqual(log.body.scans, []);
});
