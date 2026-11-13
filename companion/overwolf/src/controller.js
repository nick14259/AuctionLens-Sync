// What the Overwolf app does, without the windows: settings, when to sync, and the log.
// Everything it touches comes in as a dependency, so test/controller.test.js drives it
// with fakes in Node.
//
// When it syncs (all automatic steps can be turned off):
//   - the game wrote SavedVariables (logout, /reload, exit): upload + download, 20 s
//     after the last write, so a half-written file is never read
//   - the game closed: the same, as a backstop when the file watch missed it
//   - the game started: download only, so the guild's latest is there by login
//   - every 2 minutes: ask the server whether anyone uploaded to our markets since our
//     last download, and download if so. WoW reads AuctionLens_Crowd/Data.lua during a
//     /reload - before the save-triggered sync above can finish - so the file on disk
//     has to be current already when the reload happens.
//   - "Sync now" in the window, any time
//
// Overwolf reports WoW: Forever as World of Warcraft (class 765): its Wow.exe is in
// Overwolf's game list. VERIFY on the launch client. Only events for the configured
// folder count, so playing retail or classic from another folder triggers nothing.

import * as client from "../../../server/lib/sync/client.js";
import { winDirname, samePath } from "./owenv.js";

export const WOW_CLASS_ID = 765;
export const SAVE_SETTLE_MS = 20000;
export const EXIT_SETTLE_MS = 15000;
export const NEWS_POLL_MS = 120000;
const CONFIG_KEY = "alens.companion.config";
const LAST_KEY = "alens.companion.last";
const SEEN_KEY = "alens.companion.seen"; // market -> server "last changed" at our last download
const LOG_LIMIT = 200;

const DEFAULTS = {
    server: client.DEFAULT_SERVER,
    token: null,
    group: null,
    joinCode: null,
    label: "",
    wow: "",
    autoUpload: true,
    autoDownload: true,
};

export function createController({ ow, env, storage, timers = globalThis, now = () => Date.now(), pollMs = NEWS_POLL_MS }) {
    const read = (key, fallback) => {
        try { return JSON.parse(storage.getItem(key)) || fallback; } catch { return fallback; }
    };
    const write = (key, value) => {
        try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    };

    let cfg = { ...DEFAULTS, ...read(CONFIG_KEY, {}) };
    if (!cfg.server) cfg.server = DEFAULTS.server; // saved before there was a default
    const state = {
        busy: null,          // "sync" | "download" | "join" | ... while running
        pending: null,       // a sync asked for while another ran
        scheduled: null,     // { reason, at } when an automatic sync is waiting
        last: read(LAST_KEY, null), // { time, ok, kind, message, uploaded, downloaded, group }
        game: { running: false, path: null },
        accounts: [],        // SavedVariables files found under cfg.wow
        wowOk: null,         // does cfg.wow look like a WoW folder
        members: null,
        log: [],
    };
    const listeners = new Set();
    let timer = null;
    let pollTimer = null;
    let pollFailing = false;
    let seen = read(SEEN_KEY, {});
    const watched = new Map(); // path -> { armed }

    const snapshot = () => ({
        config: { ...cfg, token: cfg.token ? "set" : null },
        joined: !!cfg.token,
        ready: ready(),
        ...state,
        log: state.log.slice(),
    });
    function emit() {
        for (const fn of [...listeners]) {
            try { fn(snapshot()); } catch { listeners.delete(fn); } // a closed window's listener
        }
    }
    let seq = 0;
    function log(msg) {
        state.log.push({ n: ++seq, t: now(), msg: String(msg) });
        if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
        emit();
    }
    function saveConfig() {
        write(CONFIG_KEY, cfg);
    }
    function ready() {
        return !!(cfg.server && cfg.token && cfg.wow);
    }

    // One job at a time. A sync asked for during another job runs straight after it.
    async function run(kind, fn, record = true) {
        if (state.busy) {
            if (kind === "sync" || kind === "download") state.pending = state.pending === "sync" ? "sync" : kind;
            emit();
            return null;
        }
        state.busy = kind;
        emit();
        try {
            const result = await fn();
            if (record) {
                state.last = { time: now(), ok: true, kind, ...result };
                write(LAST_KEY, state.last);
            }
            return result;
        } catch (e) {
            const message = (e && e.message) || String(e);
            log(`${kind} failed: ${message}`);
            if (record) {
                state.last = { time: now(), ok: false, kind, message };
                write(LAST_KEY, state.last);
            }
            if (e && e.status === 401) {
                cfg.token = null;
                saveConfig();
                log("the server no longer knows this install - join the group again");
            }
            return null;
        } finally {
            state.busy = null;
            emit();
            const next = state.pending;
            state.pending = null;
            if (next === "sync") syncNow();
            else if (next === "download") downloadNow();
        }
    }

    function syncNow() {
        if (!ready()) return Promise.resolve(null);
        cancelScheduled();
        return run("sync", async () => {
            const r = await client.sync(env, cfg, { seen }, log);
            remember(r.seen);
            log(r.skipped ? "synced: nothing new to send or fetch"
                : `synced: sent ${r.uploaded} items, received ${r.downloaded} - /reload in game to see them`);
            await refreshWatches();
            // "received 0" would read as the guild having nothing: say it was not needed.
            return r.skipped ? { uploaded: 0, upToDate: true, group: r.group }
                : { uploaded: r.uploaded, downloaded: r.downloaded, group: r.group };
        });
    }

    function downloadNow() {
        if (!ready()) return Promise.resolve(null);
        return run("download", async () => {
            const r = await client.download(env, cfg, {}, log);
            remember(r.seen);
            return { downloaded: r.items, group: r.group };
        });
    }

    function remember(fresh) {
        if (!fresh) return;
        seen = { ...seen, ...fresh };
        write(SEEN_KEY, seen);
    }

    // Has anyone in the guild uploaded since our last download? One small status call;
    // the download (a few MB) only when the answer is yes.
    async function checkNews() {
        if (!ready() || !cfg.autoDownload || state.busy || state.scheduled) return;
        let st;
        try {
            st = await client.status(env, cfg);
        } catch (e) {
            if (e && e.status === 401) {
                cfg.token = null;
                saveConfig();
                log("the server no longer knows this install - join the group again");
                return;
            }
            // Said once per outage, not every two minutes.
            if (!pollFailing) log(`could not check for guild updates: ${e.message}`);
            pollFailing = true;
            return;
        }
        if (pollFailing) log("server reachable again");
        pollFailing = false;
        if (st.members !== state.members) { state.members = st.members; emit(); }
        if (Object.keys(seen).length === 0) {
            await downloadNow(); // never downloaded on this install: do it once
            return;
        }
        const news = client.newsFor(st, seen);
        if (news.length) {
            log(`new guild prices for ${news.join(", ")} - fetching, so your next /reload has them`);
            await downloadNow();
        }
    }

    function schedulePoll() {
        if (pollTimer) timers.clearTimeout(pollTimer);
        pollTimer = null;
        if (!pollMs) return;
        pollTimer = timers.setTimeout(async () => {
            pollTimer = null;
            try { await checkNews(); } finally { schedulePoll(); }
        }, pollMs);
    }

    function cancelScheduled() {
        if (timer) timers.clearTimeout(timer);
        timer = null;
        state.scheduled = null;
    }

    function scheduleSync(reason, delay) {
        if (!cfg.autoUpload || !ready()) return;
        // One save can arrive as several file events: say it once, restart the wait.
        const again = state.scheduled && state.scheduled.reason === reason;
        cancelScheduled();
        state.scheduled = { reason, at: now() + delay };
        timer = timers.setTimeout(() => {
            timer = null;
            state.scheduled = null;
            syncNow();
        }, delay);
        if (!again) log(`${reason} - syncing in ${Math.round(delay / 1000)} s`);
        else emit();
    }

    // SavedVariables watch. watchFile's callback fires once on registration (ignored),
    // then on each change. WoW replaces the file when it saves, which can end a watch,
    // so every event re-arms it and each sync rebuilds the set.
    function watch(path) {
        if (!ow || !ow.io || typeof ow.io.watchFile !== "function") return;
        const entry = { armed: false };
        watched.set(path, entry);
        ow.io.watchFile(path, (r) => {
            if (watched.get(path) !== entry) return;
            if (!entry.armed) { entry.armed = true; return; }
            scheduleSync("game saved its data", SAVE_SETTLE_MS);
            const type = String((r && r.eventType) || "").toLowerCase();
            if (type.includes("renam") || type.includes("delet")) {
                timers.setTimeout(() => { unwatch(path); watch(path); }, 3000);
            }
        });
    }
    function unwatch(path) {
        watched.delete(path);
        if (ow && ow.io && typeof ow.io.stopWatchingFile === "function") {
            try { ow.io.stopWatchingFile(path, () => {}); } catch { /* already stopped */ }
        }
    }
    async function refreshWatches() {
        for (const p of [...watched.keys()]) unwatch(p);
        state.accounts = cfg.wow ? await client.findSavedVariables(env, cfg.wow) : [];
        state.wowOk = cfg.wow ? await client.looksLikeWow(env, cfg.wow) : null;
        for (const p of state.accounts) watch(p);
        emit();
    }

    // overwolf.games.onGameInfoUpdated / getRunningGameInfo payloads.
    async function onGameInfo(event) {
        const gi = event && (event.gameInfo || event);
        if (!gi || Math.floor(Number(gi.id) / 10) !== WOW_CLASS_ID) return;
        const folder = gi.executionPath ? winDirname(gi.executionPath) : null;
        // First run: take the folder the game runs from, if AuctionLens has data there.
        if (!cfg.wow && folder && (await client.findSavedVariables(env, folder)).length > 0) {
            cfg.wow = folder;
            saveConfig();
            log(`found AuctionLens data in ${folder}`);
            await refreshWatches();
        }
        if (cfg.wow && folder && !samePath(folder, cfg.wow)) return; // another WoW install
        const running = !!gi.isRunning;
        if (running === state.game.running) return;
        state.game = { running, path: folder };
        emit();
        if (running) {
            log("game started");
            if (cfg.autoDownload) downloadNow();
        } else {
            log("game closed");
            scheduleSync("game closed", EXIT_SETTLE_MS);
        }
    }

    async function start() {
        await refreshWatches();
        schedulePoll();
        if (!ready() && !(cfg.server && cfg.token)) return;
        try {
            const st = await client.status(env, cfg);
            state.members = st.members;
            cfg.group = st.group;
            cfg.joinCode = st.joinCode;
            saveConfig();
            emit();
        } catch (e) {
            log(`could not reach the server: ${e.message}`);
        }
    }

    return {
        snapshot,
        subscribe(fn) {
            listeners.add(fn);
            fn(snapshot());
            return () => listeners.delete(fn);
        },
        start,
        async setConfig(patch) {
            const wowChanged = "wow" in patch && patch.wow !== cfg.wow;
            cfg = { ...cfg, ...patch };
            saveConfig();
            if (wowChanged) await refreshWatches();
            emit();
        },
        join(server, code, label) {
            return run("join", async () => {
                const r = await client.joinGroup(env, server.trim(), code, label);
                cfg = { ...cfg, server: server.trim(), token: r.token, group: r.group, label: label || cfg.label };
                saveConfig();
                seen = {}; // another group's data: download afresh
                write(SEEN_KEY, seen);
                log(`joined "${r.group}"`);
                await start();
                return {};
            }, false);
        },
        create(server, name, label, secret) {
            return run("create", async () => {
                const r = await client.createGroup(env, server.trim(), name, label, secret);
                cfg = { ...cfg, server: server.trim(), token: r.token, group: r.group, joinCode: r.joinCode, label: label || cfg.label };
                saveConfig();
                seen = {};
                write(SEEN_KEY, seen);
                log(`created "${r.group}" - join code ${r.joinCode}`);
                await start();
                return {};
            }, false);
        },
        leave() {
            return run("leave", async () => {
                try { await client.leave(env, cfg); } catch (e) { log(`server: ${e.message}`); }
                cfg = { ...cfg, token: null, group: null, joinCode: null };
                state.members = null;
                saveConfig();
                log("left the group");
                return {};
            }, false);
        },
        syncNow,
        downloadNow,
        onGameInfo,
        refreshWatches,
        checkNews,
        _scheduleSync: scheduleSync,
    };
}
