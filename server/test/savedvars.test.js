import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSavedVariables } from "../lib/sync/savedvars.js";

const SAMPLE = `
AuctionLensDB = {
["schema"] = 3,
["markets"] = {
["US-R\\195\\169alm-Horde"] = {
["meta"] = {
["lastScan"] = 1794586803,
},
["items"] = {
["9859:b12744"] = {
["l"] = "tog81f,2xk,2xk,2,2,0,2",
["d"] = "g0u,4mo,4mo,4h4,4h4,4h4,2,2,0,2;1,,,,,,-2,-2,2,1",
},
},
},
},
["list"] = {
"a", -- [1]
nil, -- [2]
"c \\"quoted\\"\\n", -- [3]
},
["flags"] = { true, false, -1.5, 1e3, 0x1F },
plain = [[long
string]],
}
Other = nil
`;

test("reads what the client writes: nesting, escapes, positional entries and comments", () => {
    const out = parseSavedVariables(SAMPLE);
    const db = out.AuctionLensDB;
    assert.equal(db.schema, 3);
    const market = Object.keys(db.markets)[0];
    assert.equal(market, "US-R\u00c3\u00a9alm-Horde", "decimal escapes are bytes, kept as latin1 chars");
    assert.equal(db.markets[market].meta.lastScan, 1794586803);
    assert.equal(db.markets[market].items["9859:b12744"].l, "tog81f,2xk,2xk,2,2,0,2");
    assert.equal(db.list[1], "a");
    assert.equal(db.list[2], undefined, "nil holes stay holes");
    assert.equal(db.list[3], 'c "quoted"\n');
    assert.deepEqual([db.flags[1], db.flags[2], db.flags[3], db.flags[4], db.flags[5]], [true, false, -1.5, 1000, 31]);
    assert.equal(db.plain, "long\nstring");
    assert.equal(out.Other, null);
});

test("says where a broken file breaks", () => {
    assert.throws(() => parseSavedVariables('X = {\n["a"] = \n'), /line 3/);
    assert.throws(() => parseSavedVariables('X = { ["a"] = "x" "y" }'), /expected ',' or '}'/);
});
