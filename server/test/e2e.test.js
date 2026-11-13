// The whole loop over HTTP: two players' SavedVariables -> companion upload -> local
// server (dev.js, PGlite) -> companion download -> AuctionLens_Crowd/Data.lua.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDev } from "../dev.js";
import { upload, download } from "../../companion/cli.js";
import { encodeDeltaRows, encodeRow, decodeDeltaRows } from "../lib/sync/codec.js";
import { layout, D } from "../lib/sync/format.js";
import { luaString } from "../lib/sync/payload.js";

const lay = layout(3);
const NOW = Math.floor(Date.now() / 1000);
const TODAY = Math.floor(NOW / 86400);
// A realm name with an accent: the client writes it as UTF-8, and both companions read
// and write UTF-8, so it is one market key whoever uploaded it.
const MK = "EU-Réalm-Alliance";
let dev, dir;

before(async () => {
    dev = await startDev({ port: 0, memory: true, quiet: true });
    dir = mkdtempSync(join(tmpdir(), "alens-e2e-"));
});
after(async () => {
    await dev.close();
    rmSync(dir, { recursive: true, force: true });
});

/** A WoW folder with one account whose AuctionLens SavedVariables hold `items`. */
function wowFolder(name, items) {
    const wow = join(dir, name);
    const sv = join(wow, "WTF", "Account", "ACCT", "SavedVariables");
    mkdirSync(sv, { recursive: true });
    const lines = ["AuctionLensDB = {", '["schema"] = 3,', '["markets"] = {', `[${luaString(MK)}] = {`,
        '["meta"] = {', `["lastScan"] = ${NOW - 60},`, "},", '["items"] = {'];
    for (const [key, rec] of Object.entries(items)) {
        lines.push(`[${luaString(key)}] = {`);
        for (const [f, v] of Object.entries(rec)) lines.push(`[${luaString(f)}] = ${luaString(v)},`);
        lines.push("},");
    }
    lines.push("},", "},", "},", "}");
    writeFileSync(join(sv, "AuctionLens.lua"), lines.join("\n"), "utf8");
    return wow;
}

const quiet = () => {};

test("two members' scans come back merged in the guild data addon", async () => {
    const base = `http://localhost:${dev.port}`;
    const created = await (await fetch(base + "/api/group", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E" }),
    })).json();
    const joined = await (await fetch(base + "/api/join", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.joinCode }),
    })).json();

    const wowA = wowFolder("a", {
        "2589": {
            l: encodeRow([NOW - 3600, 120, 130, 40, 6, null, 30], 7),
            d: encodeDeltaRows([[TODAY - 2, 100, 110, 95, 105, 90, 30, 40, 5, 8],
                                [TODAY - 1, 105, 125, 100, 120, 98, 35, 41, 6, 9]], 10, lay.dDelta),
            p: "not sent",
        },
    });
    const wowB = wowFolder("b", {
        "2589": {
            l: encodeRow([NOW - 120, 115, 128, 44, 7, null, 33], 7),
            d: encodeDeltaRows([[TODAY - 1, 106, 140, 99, 118, 97, 36, 50, 4, 3]], 10, lay.dDelta),
        },
        "9859:b12744": {
            l: encodeRow([NOW - 120, 5000, 5200, 2, 2, null, 2], 7),
            d: encodeDeltaRows([[TODAY - 1, 5200, 5200, 5200, 5200, 5000, 2, 2, null, 1]], 10, lay.dDelta),
        },
    });
    const cfgA = { server: base, token: created.token, wow: wowA };
    const cfgB = { server: base, token: joined.token, wow: wowB };

    assert.equal(await upload(cfgA, {}, quiet), 1);
    assert.equal(await upload(cfgB, {}, quiet), 2);
    assert.equal(await upload(cfgA, {}, quiet), 0, "no scan since the last upload: nothing sent");
    // A new scan in the game: sent again, from yesterday on.
    const svA = join(wowA, "WTF", "Account", "ACCT", "SavedVariables", "AuctionLens.lua");
    writeFileSync(svA, readFileSync(svA, "utf8").replace(`["lastScan"] = ${NOW - 60}`, `["lastScan"] = ${NOW - 5}`));
    assert.equal(await upload(cfgA, {}, quiet), 1, "after a new scan it sends again");

    const data = await download(cfgA, {}, quiet);
    assert.equal(data.group, "E2E");
    const m = data.markets[MK];
    assert.ok(m, "the realm name survives the trip byte for byte");
    assert.equal(m.members, 2);
    const byKey = Object.fromEntries(m.items.map(([k, l, d]) => [k, { l, d }]));
    assert.equal(byKey["2589"].l, encodeRow([NOW - 120, 115, 128, 44, 7, null, 33], 7), "B's point is newer");
    const rows = decodeDeltaRows(byKey["2589"].d, 10, lay.dDelta);
    assert.deepEqual(rows.map((r) => r[D.DAY]), [TODAY - 2, TODAY - 1]);
    assert.equal(rows[1][D.HIGH], 140);
    assert.equal(rows[1][D.CLOSE], 120, "A scanned that day more often");
    assert.ok(byKey["9859:b12744"], "an item only B saw reaches A");

    const addon = join(wowA, "Interface", "AddOns", "AuctionLens_Crowd");
    const lua = readFileSync(join(addon, "Data.lua"), "utf8");
    assert.match(lua, /^AuctionLensCrowdData = \{$/m);
    assert.ok(lua.includes(luaString(MK)));
    assert.match(readFileSync(join(addon, "AuctionLens_Crowd.toc"), "utf8"), /^## Interface: 16001$/m);
    assert.ok(!lua.includes("not sent"), "intraday points never leave the machine");
});
