import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeDeltaRows, decodeDeltaRows, encodeRow } from "../lib/sync/codec.js";
import { D, layout } from "../lib/sync/format.js";
import { mergeDay, mergeDaily, newerPoint, buildBatches, renderCrowdLua, luaString, MAX_BATCH_ITEMS } from "../lib/sync/payload.js";

const lay = layout(3);
//            day   open high low  close floor avgQ maxQ sold scans
const a = [20500, 100, 150, 90, 120, 80, 10, 14, 3, 4];
const b = [20500, 110, 170, 95, 115, 70, 12, 20, 5, 9];

test("merging a day keeps the extremes and the busier observer's readings", () => {
    const m = mergeDay(a, b);
    assert.equal(m[D.HIGH], 170);
    assert.equal(m[D.LOW], 90);
    assert.equal(m[D.FLOOR], 70);
    assert.equal(m[D.MAXQ], 20);
    assert.equal(m[D.SOLD], 5, "the larger estimate, not the sum: both saw the same sales");
    assert.equal(m[D.SCANS], 9);
    assert.equal(m[D.OPEN], 110, "b scanned more");
    assert.equal(m[D.CLOSE], 115);
    assert.equal(m[D.AVGQ], 12);
});

test("merging is idempotent and does not care who came first for extremes", () => {
    assert.deepEqual(mergeDay(a, a), a);
    const ab = mergeDay(a, b);
    assert.deepEqual(mergeDay(ab, b), ab, "the same upload twice changes nothing");
    assert.deepEqual(mergeDay(ab, a), ab);
    const ba = mergeDay(b, a);
    for (const f of [D.HIGH, D.LOW, D.FLOOR, D.MAXQ, D.SOLD, D.SCANS]) assert.equal(ab[f], ba[f]);
});

test("a nil reading does not erase a known one", () => {
    const m = mergeDay([20500, null, null, null, null, null, 0, 0, null, 1], a);
    assert.equal(m[D.LOW], 90);
    const n = mergeDay(a, [20500, null, null, null, null, null, 0, 0, null, 1]);
    assert.equal(n[D.LOW], 90);
    assert.equal(n[D.OPEN], 100, "a's 4 scans beat 1");
});

test("daily series merge per day, in order, trimmed to the newest", () => {
    const older = [[20498, 1, 1, 1, 1, 1, 1, 1, null, 1], a];
    const newer = [b, [20501, 2, 2, 2, 2, 2, 2, 2, null, 2]];
    const rows = mergeDaily(older, newer, 90);
    assert.deepEqual(rows.map((r) => r[D.DAY]), [20498, 20500, 20501]);
    assert.deepEqual(mergeDaily(older, newer, 2).map((r) => r[D.DAY]), [20500, 20501]);
});

test("the newer of two latest points wins", () => {
    const p1 = encodeRow([1794000000, 5, 6, 1, 1, null, 1], 7);
    const p2 = encodeRow([1794000900, 7, 8, 1, 1, null, 1], 7);
    assert.equal(newerPoint(p1, p2, 7), p2);
    assert.equal(newerPoint(p2, p1, 7), p2);
    assert.equal(newerPoint("", p1, 7), p1);
    assert.equal(newerPoint(p1, "", 7), p1);
});

function market(n) {
    const items = {};
    for (let i = 0; i < n; i++) {
        const rows = [[20500, 10, 10, 10, 10, 10, 1, 1, null, 1], [20501, 11, 12, 9, 11, 9, 1, 1, null, 2]];
        items[String(1000 + i)] = {
            d: encodeDeltaRows(rows, 10, lay.dDelta),
            l: encodeRow([20501 * 86400 + 100, 9, 11, 1, 1, null, 1], 7),
            p: "ignored",
        };
    }
    items["9:b1"] = { p: "" }; // nothing to send
    return { market: "US-Test-Horde", lastScan: 20501 * 86400 + 100, items };
}

test("batches carry newest point and daily rows, never intraday points", () => {
    const [batch] = buildBatches(3, market(3), undefined);
    assert.equal(batch.v, 1);
    assert.equal(batch.items.length, 3, "an item with nothing to send is left out");
    for (const [, l, d] of batch.items) {
        assert.ok(l && d);
        assert.equal(decodeDeltaRows(d, 10, lay.dDelta).length, 2);
    }
    assert.ok(!JSON.stringify(batch).includes("ignored"));
});

test("a later upload sends only the days from the mark on", () => {
    const [batch] = buildBatches(3, market(2), 20501);
    const rows = decodeDeltaRows(batch.items[0][2], 10, lay.dDelta);
    assert.deepEqual(rows.map((r) => r[D.DAY]), [20501]);
    assert.deepEqual(rows[0], [20501, 11, 12, 9, 11, 9, 1, 1, null, 2], "re-encoded from absolute values");
    assert.equal(buildBatches(3, market(2), 20502).length, 0, "nothing newer: no batch");
});

test("big markets are split under the request limit", () => {
    const batches = buildBatches(3, market(MAX_BATCH_ITEMS + 10), undefined);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].items.length, MAX_BATCH_ITEMS);
});

test("the guild data file is plain Lua, with every string escaped", () => {
    assert.equal(luaString('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\001"');
    const text = renderCrowdLua({ group: 'The "Guild"', generated: 5, schema: 3, markets: {
        "US-Test-Horde": { updated: 4, members: 2, items: [["1", "a,b", "c;d"]] } } });
    assert.match(text, /^AuctionLensCrowdData = \{$/m);
    assert.match(text, /group = "The \\"Guild\\"",/);
    assert.match(text, /t\["1"\]=\{"a,b","c;d"\}/);
    assert.match(text, /members = 2/);
});
