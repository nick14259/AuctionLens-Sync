// The JavaScript codec must read and write exactly what AuctionLens/Data/Codec.lua does:
// fixtures/codec_lua.json was encoded by the Lua codec itself (tools/codec_fixture.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeInt, decodeInt, encodeRow, decodeRow, encodeDeltaRows, decodeDeltaRows } from "../lib/sync/codec.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/codec_lua.json", import.meta.url), "utf8"));

test("encodes rows byte for byte as the Lua codec does", () => {
    assert.ok(cases.length >= 50);
    for (const c of cases) {
        const delta = new Set(c.delta);
        assert.equal(encodeDeltaRows(c.rows, c.width, delta), c.encoded);
        if (c.rows.length) assert.equal(encodeRow(c.rows[c.rows.length - 1], c.width), c.last);
    }
});

test("decodes what the Lua codec wrote", () => {
    for (const c of cases) {
        const delta = new Set(c.delta);
        assert.deepEqual(decodeDeltaRows(c.encoded, c.width, delta), c.rows);
        if (c.rows.length) assert.deepEqual(decodeRow(c.last, c.width), c.rows[c.rows.length - 1]);
    }
});

test("numbers: sign, zero, nil, rounding and large values", () => {
    assert.equal(encodeInt(null), "");
    assert.equal(encodeInt(0), "0");
    assert.equal(encodeInt(-35), "-z");
    assert.equal(encodeInt(2.5), "3", "Lua rounds half up");
    assert.equal(encodeInt(-2.5), "-2", "floor(n + 0.5)");
    assert.equal(decodeInt("3oazri8"), 8000000000, "past 32 bits");
    assert.equal(decodeInt(""), null);
    assert.equal(decodeInt("-"), null);
    assert.equal(decodeInt("x!"), null);
});

test("a short row reads its missing fields as nil", () => {
    assert.deepEqual(decodeRow("1,2", 4), [1, 2, null, null]);
    assert.deepEqual(decodeDeltaRows("", 3, new Set([0])), []);
});
