// The Overwolf app's controller, driven with a fake Overwolf (file watches, game events),
// fake timers, and the real API on server/dev.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDev } from "../../../server/dev.js";
import { nodeEnv } from "../../cli.js";
import { createController, SAVE_SETTLE_MS, EXIT_SETTLE_MS } from "../src/controller.js";
import { makeOverwolfEnv, winJoin, winDirname, samePath } from "../src/owenv.js";
import { encodeDeltaRows, encodeRow } from "../../../server/lib/sync/codec.js";
import { layout } from "../../../server/lib/sync/format.js";
import { luaString } from "../../../server/lib/sync/payload.js";

const lay = layout(3);
const NOW = Math.floor(Date.now() / 1000);
const TODAY = Math.floor(NOW / 86400);
let dev, dir, server;

before(async () => {
    dev = await startDev({ port: 0, memory: true, quiet: true });
    server = `http://localhost:${dev.port}`;
    dir = mkdtempSync(join(tmpdir(), "alens-ow-"));
});
after(async () => {
    await dev.close();
    rmSync(dir, { recursive: true, force: true });
});

function wowFolder(name) {
    const wow = join(dir, name);
    const sv = join(wow, "WTF", "Account", "ACCT", "SavedVariables");
    mkdirSync(sv, { recursive: true });
    mkdirSync(join(wow, "Interface", "AddOns"), { recursive: true });
    const d = encodeDeltaRows([[TODAY - 1, 100, 110, 95, 105, 90, 30, 40, 5, 8]], 10, lay.dDelta);
    const l = encodeRow([NOW - 600, 120, 130, 40, 6, null, 30], 7);
    writeFileSync(join(sv, "AuctionLens.lua"), [
        "AuctionLensDB = {", '["schema"] = 3,', '["markets"] = {', `[${luaString("US-Test-Horde")}] = {`,
        `["meta"] = { ["lastScan"] = ${NOW - 600} },`, '["items"] = {',
        `["2589"] = { ["l"] = ${luaString(l)}, ["d"] = ${luaString(d)} },`, "},", "},", "},", "}"].join("\n"));
    return wow;
}

function fakes() {
    const watches = new Map();
    const ow = {
        io: {
            watchFile: (path, cb) => { watches.set(path, cb); cb({ eventType: "registered", path }); },
            stopWatchingFile: (path, cb) => { watches.delete(path); cb && cb({}); },
        },
    };
    const queue = [];
    const timers = {
        setTimeout: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; },
        clearTimeout: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); },
    };
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
    return { ow, watches, timers, queue, storage, store };
}

/** Lets the controller's promise chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(pred, ms = 5000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await settle();
    }
}

async function joinedController(name) {
    const f = fakes();
    const wow = wowFolder(name);
    const ctl = createController({ ow: f.ow, env: nodeEnv, storage: f.storage, timers: f.timers });
    const created = await (await fetch(server + "/api/group", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "OW " + name }),
    })).json();
    await ctl.join(server, created.joinCode, "tester");
    await ctl.setConfig({ wow });
    return { ctl, f, wow };
}

test("paths: joins, parents and comparisons the Windows way", () => {
    assert.equal(winJoin("E:\\World of Warcraft\\_forever_\\", "WTF", "Account"), "E:\\World of Warcraft\\_forever_\\WTF\\Account");
    assert.equal(winJoin("E:/WoW/_forever_", "/Interface/"), "E:\\WoW\\_forever_\\Interface");
    assert.equal(winDirname("E:/World of Warcraft/_forever_/Wow.exe"), "E:\\World of Warcraft\\_forever_");
    assert.ok(samePath("e:\\world of warcraft\\_FOREVER_\\", "E:/World of Warcraft/_forever_"));
    assert.ok(!samePath("", ""));
});

test("the Overwolf file adapter maps io results and errors", async () => {
    const files = { "C:\\a.txt": "héllo" };
    const io = {
        enums: { eEncoding: { UTF8: "UTF8" } },
        readTextFile: (p, opt, cb) => cb(p in files ? { success: true, content: files[p] } : { success: false, error: "not found" }),
        writeFileContents: (p, c, enc, uac, cb) => { files[p] = c; cb({ success: enc === "UTF8" }); },
        exist: (p, cb) => cb({ success: true, exist: p in files || p === "C:\\dir" }),
        dir: (p, cb) => cb(p === "C:\\dir" ? { success: true, data: [{ name: "x", type: "dir" }] } : { success: false }),
    };
    const env = makeOverwolfEnv({ io }, () => {});
    assert.equal(await env.readText("C:\\a.txt"), "héllo");
    await assert.rejects(env.readText("C:\\nope.txt"), /cannot read C:\\nope.txt: not found/);
    await env.writeText("C:\\b.txt", "x");
    assert.equal(files["C:\\b.txt"], "x");
    assert.equal(await env.exists("C:\\dir"), true);
    assert.equal(await env.exists("C:\\zzz"), false);
    assert.deepEqual(await env.listDir("C:\\dir"), ["x"]);
    assert.deepEqual(await env.listDir("C:\\zzz"), []);
});

test("join, then settings persist and the token never leaves the controller", async () => {
    const { ctl, f } = await joinedController("persist");
    const s = ctl.snapshot();
    assert.equal(s.joined, true);
    assert.equal(s.ready, true);
    assert.equal(s.config.group, "OW persist");
    assert.match(s.config.joinCode, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.equal(s.config.token, "set", "the window sees that a token exists, not the token");
    assert.equal(s.accounts.length, 1);
    const saved = JSON.parse(f.store.get("alens.companion.config"));
    assert.match(saved.token, /^[0-9a-f]{64}$/, "kept for the next start");
});

test("a SavedVariables write syncs once, after the game has finished writing", async () => {
    const { ctl, f, wow } = await joinedController("watch");
    assert.equal(f.watches.size, 1, "the account's file is watched");
    const [path, fire] = [...f.watches.entries()][0];
    assert.ok(path.endsWith("AuctionLens.lua"));
    assert.equal(f.queue.length, 0, "registration itself is not a change");

    fire({ eventType: "changed", path });
    fire({ eventType: "changed", path });
    assert.equal(f.queue.length, 1, "two writes, one pending sync");
    assert.equal(f.queue[0].ms, SAVE_SETTLE_MS);
    assert.ok(ctl.snapshot().scheduled);

    f.queue.shift().fn();
    await until(() => ctl.snapshot().last && !ctl.snapshot().busy);
    const last = ctl.snapshot().last;
    assert.equal(last.ok, true, last.message);
    assert.equal(last.uploaded, 1);
    assert.equal(last.downloaded, 1);
    const data = readFileSync(join(wow, "Interface", "AddOns", "AuctionLens_Crowd", "Data.lua"), "utf8");
    assert.match(data, /group = "OW watch"/);
    assert.equal(f.watches.size, 1, "watching again after the sync");
});

test("the game starting fetches, the game closing syncs; other installs and games are ignored", async () => {
    const { ctl, f, wow } = await joinedController("game");
    await ctl.onGameInfo({ id: 7651, isRunning: true, executionPath: join(wow, "Wow.exe") });
    await until(() => ctl.snapshot().last && !ctl.snapshot().busy);
    assert.equal(ctl.snapshot().game.running, true);
    assert.equal(ctl.snapshot().last.kind, "download");

    await ctl.onGameInfo({ id: 7651, isRunning: false, executionPath: "C:\\Games\\WoW\\_retail_\\Wow.exe" });
    assert.equal(ctl.snapshot().game.running, true, "another WoW folder: not ours");
    await ctl.onGameInfo({ id: 54261, isRunning: false });
    assert.equal(ctl.snapshot().game.running, true, "another game");

    await ctl.onGameInfo({ id: 7651, isRunning: false, executionPath: join(wow, "Wow.exe") });
    assert.equal(ctl.snapshot().game.running, false);
    assert.equal(f.queue.length, 1);
    assert.equal(f.queue[0].ms, EXIT_SETTLE_MS);
});

test("first run: the folder is found from the running game", async () => {
    const f = fakes();
    const wow = wowFolder("detect");
    const ctl = createController({ ow: f.ow, env: nodeEnv, storage: f.storage, timers: f.timers });
    await ctl.onGameInfo({ id: 7651, isRunning: true, executionPath: join(wow, "Wow.exe").replace(/\\/g, "/") });
    assert.ok(samePath(ctl.snapshot().config.wow, wow));
    assert.equal(ctl.snapshot().accounts.length, 1);
});

test("automatic syncs can be turned off, and nothing runs before joining", async () => {
    const { ctl, f } = await joinedController("off");
    await ctl.setConfig({ autoUpload: false });
    const fire = [...f.watches.values()][0];
    fire({ eventType: "changed" });
    assert.equal(f.queue.length, 0);

    const g = fakes();
    const fresh = createController({ ow: g.ow, env: nodeEnv, storage: g.storage, timers: g.timers });
    assert.equal(await fresh.syncNow(), null);
    assert.equal(fresh.snapshot().ready, false);
});

test("a fresh install starts with the guild server filled in", () => {
    const g = fakes();
    const fresh = createController({ ow: g.ow, env: nodeEnv, storage: g.storage, timers: g.timers });
    assert.equal(fresh.snapshot().config.server, "https://auctionlens-project-server.vercel.app");
    g.store.set("alens.companion.config", JSON.stringify({ server: "" }));
    const older = createController({ ow: g.ow, env: nodeEnv, storage: g.storage, timers: g.timers });
    assert.equal(older.snapshot().config.server, "https://auctionlens-project-server.vercel.app",
        "also for settings saved before there was a default");
});

test("a sync asked for during another runs straight after it", async () => {
    const { ctl } = await joinedController("queue");
    const first = ctl.syncNow();
    ctl.syncNow();
    assert.equal(ctl.snapshot().pending, "sync");
    await first;
    await until(() => !ctl.snapshot().busy && !ctl.snapshot().pending);
    const syncs = ctl.snapshot().log.filter((e) => e.msg.startsWith("synced:"));
    assert.equal(syncs.length, 2);
});

test("leaving the group forgets the token here and on the server", async () => {
    const { ctl } = await joinedController("leaver");
    await ctl.leave();
    assert.equal(ctl.snapshot().joined, false);
    assert.ok(ctl.snapshot().log.some((e) => e.msg === "left the group"));
});

test("a token the server forgot sends the user back to joining", async () => {
    const { ctl, f } = await joinedController("forgotten");
    const token = JSON.parse(f.store.get("alens.companion.config")).token;
    // Removed on the server behind the app's back (another install left with it).
    await fetch(server + "/api/leave", { method: "POST", headers: { authorization: "Bearer " + token } });
    await ctl.syncNow();
    assert.equal(ctl.snapshot().joined, false);
    assert.ok(ctl.snapshot().log.some((e) => /join the group again/.test(e.msg)));
});

test("errors land in the log and the last result, not in an exception", async () => {
    const { ctl } = await joinedController("errors");
    await ctl.setConfig({ server: "http://localhost:1" });
    await ctl.syncNow();
    const last = ctl.snapshot().last;
    assert.equal(last.ok, false);
    assert.match(last.message, /cannot reach/);
    assert.ok(ctl.snapshot().log.some((e) => /sync failed/.test(e.msg)));
});

test("the manifest starts on the background page and asks for what the app uses", () => {
    const manifest = JSON.parse(readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"));
    assert.equal(manifest.data.start_window, "background");
    assert.ok(manifest.data.windows.background.is_background_page);
    assert.deepEqual(manifest.data.game_targeting.game_ids, [765]);
    for (const p of ["FileSystem", "GameInfo"]) assert.ok(manifest.permissions.includes(p));
    for (const f of ["background.html", "main.html"]) {
        assert.ok(existsSync(new URL(`../static/${f}`, import.meta.url)), f);
    }
});
