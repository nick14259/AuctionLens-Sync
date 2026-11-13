// What the desktop app supplies in place of Overwolf, without Electron in it, so
// test/host.test.js runs in plain Node:
//   storage          localStorage-shaped, one JSON file in the app's data folder
//   watchFile        overwolf.io.watchFile, from fs.watch on the file's folder
//   game events      `tasklist` every 15 s for Wow.exe, its path from PowerShell once

import { readFileSync, writeFileSync, mkdirSync, watch as fsWatch } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { WOW_CLASS_ID } from "../../overwolf/src/controller.js";

export const GAME_POLL_MS = 15000;
// Full paths: a PATH without System32 (it happens) must not blind the game check.
const SYSTEM32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const TASKLIST = join(SYSTEM32, "tasklist.exe");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");

/** The command-line companion's settings file. */
export function cliConfigPath() {
    const dir = process.env.APPDATA ? join(process.env.APPDATA, "AuctionLensCompanion")
        : join(homedir(), ".config", "auctionlens-companion");
    return join(dir, "config.json");
}

export function fileStorage(file) {
    let data = {};
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
    return {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
        setItem: (k, v) => {
            data[k] = String(v);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(data, null, 2));
        },
    };
}

/** First start on a machine that used the CLI: take its server, token and folder. */
export function seedFromCli(storage, cliFile) {
    if (storage.getItem("alens.companion.config")) return false;
    let cli;
    try { cli = JSON.parse(readFileSync(cliFile, "utf8")); } catch { return false; }
    if (!cli || !cli.server) return false;
    storage.setItem("alens.companion.config", JSON.stringify({
        server: cli.server, token: cli.token || null, group: cli.group || null, wow: cli.wow || "",
        autoUpload: true, autoDownload: true,
    }));
    return true;
}

/** overwolf.io.watchFile / stopWatchingFile. Watching the folder survives WoW replacing the file. */
export function nodeWatcher(watchImpl = fsWatch) {
    const watchers = new Map();
    return {
        watchFile(path, cb) {
            const name = basename(path).toLowerCase();
            cb({ eventType: "registered", path }); // as Overwolf does
            try {
                const w = watchImpl(dirname(path), (eventType, file) => {
                    if (file && String(file).toLowerCase() === name) cb({ eventType: "changed", path });
                });
                if (w && w.on) w.on("error", () => {});
                watchers.set(path, w);
            } catch { /* folder missing: the next refresh tries again */ }
        },
        stopWatchingFile(path, cb) {
            const w = watchers.get(path);
            if (w && w.close) w.close();
            watchers.delete(path);
            if (cb) cb({ success: true });
        },
        _count: () => watchers.size,
    };
}

export function runCommand(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
    });
}

/**
 * Reports Wow.exe starting and stopping to the controller the way Overwolf's game events
 * would. Returns { tick, stop } (tick is exposed for tests).
 */
export function gamePoller(ctl, { exec = runCommand, interval = GAME_POLL_MS, timers = globalThis } = {}) {
    let running = false, path = null;
    async function tick() {
        const out = await exec(TASKLIST, ["/FI", "IMAGENAME eq Wow.exe", "/FO", "CSV", "/NH"]);
        const now = /"wow\.exe"/i.test(out);
        if (now === running) return;
        running = now;
        if (now) {
            const p = (await exec(POWERSHELL, ["-NoProfile", "-Command",
                "(Get-Process -Name Wow -ErrorAction SilentlyContinue | Select-Object -First 1).Path"])).trim();
            path = p || null;
        }
        await ctl.onGameInfo({ id: WOW_CLASS_ID * 10, isRunning: running, executionPath: path });
    }
    const handle = interval ? timers.setInterval(tick, interval) : null;
    if (interval) tick();
    return { tick, stop: () => handle && timers.clearInterval(handle) };
}
