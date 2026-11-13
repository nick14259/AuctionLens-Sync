// The desktop app's stand-ins for Overwolf, in plain Node (no Electron needed).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileStorage, seedFromCli, nodeWatcher, gamePoller } from "../src/host.js";

const dir = mkdtempSync(join(tmpdir(), "alens-desk-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("settings survive a restart", () => {
    const file = join(dir, "s", "settings.json");
    const a = fileStorage(file);
    assert.equal(a.getItem("x"), null);
    a.setItem("x", JSON.stringify({ n: 1 }));
    const b = fileStorage(file);
    assert.deepEqual(JSON.parse(b.getItem("x")), { n: 1 });
    assert.equal(b.getItem("constructor"), null, "only its own keys");
});

test("first start takes the command-line companion's join, once", () => {
    const cli = join(dir, "cli.json");
    writeFileSync(cli, JSON.stringify({ server: "https://x.vercel.app", token: "t".repeat(64), group: "G", wow: "E:\\WoW\\_forever_" }));
    const s = fileStorage(join(dir, "seed.json"));
    assert.equal(seedFromCli(s, cli), true);
    const cfg = JSON.parse(s.getItem("alens.companion.config"));
    assert.equal(cfg.server, "https://x.vercel.app");
    assert.equal(cfg.wow, "E:\\WoW\\_forever_");
    assert.equal(cfg.autoUpload, true);
    assert.equal(seedFromCli(s, cli), false, "never over settings it already has");
    assert.equal(seedFromCli(fileStorage(join(dir, "none.json")), join(dir, "missing.json")), false);
});

test("the file watch reports saves, including WoW's replace-the-file kind", async () => {
    const sv = join(dir, "SavedVariables");
    const file = join(sv, "AuctionLens.lua");
    mkdirSync(sv, { recursive: true });
    writeFileSync(file, "AuctionLensDB = {}");
    const w = nodeWatcher();
    const events = [];
    w.watchFile(file, (e) => events.push(e.eventType));
    assert.deepEqual(events, ["registered"], "fires once on registration, like Overwolf");

    writeFileSync(join(sv, "Other.lua"), "x"); // another addon's file: ignored
    writeFileSync(join(sv, "AuctionLens.lua.tmp"), "AuctionLensDB = { a = 1 }");
    renameSync(join(sv, "AuctionLens.lua.tmp"), file);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(events.filter((e) => e === "changed").length >= 1, events.join(","));
    assert.equal(w._count(), 1);
    w.stopWatchingFile(file);
    assert.equal(w._count(), 0);
    assert.equal(readFileSync(file, "utf8"), "AuctionLensDB = { a = 1 }");
});

test("Wow.exe starting and stopping reach the controller as game events", async () => {
    let running = false;
    const exec = async (cmd) => {
        if (/tasklist/i.test(cmd)) return running ? '"Wow.exe","1234","Console","1","2,000,000 K"\r\n' : "INFO: No tasks are running";
        return "E:\\World of Warcraft\\_forever_\\Wow.exe\r\n";
    };
    const seen = [];
    const ctl = { onGameInfo: async (gi) => seen.push(gi) };
    const p = gamePoller(ctl, { exec, interval: 0 });
    await p.tick();
    assert.equal(seen.length, 0, "not running, no change");
    running = true;
    await p.tick();
    await p.tick();
    assert.equal(seen.length, 1, "one event per change");
    assert.deepEqual(seen[0], { id: 7650, isRunning: true, executionPath: "E:\\World of Warcraft\\_forever_\\Wow.exe" });
    running = false;
    await p.tick();
    assert.equal(seen[1].isRunning, false);
    assert.equal(seen[1].executionPath, "E:\\World of Warcraft\\_forever_\\Wow.exe", "the folder it ran from");
});
