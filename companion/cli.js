#!/usr/bin/env node
// AuctionLens companion, command-line edition: what the Overwolf app (companion/overwolf)
// does on its own when the game closes, done by hand. Node 20+, no install step.
//
//   node companion/cli.js create [server] "<guild name>" [--label <you>] [--secret <s>]
//   node companion/cli.js join   [server] <JOIN-CODE>    [--label <you>]
//     (server defaults to https://auctionlens-project-server.vercel.app)
//   node companion/cli.js config --wow "C:\Program Files (x86)\World of Warcraft\_forever_"
//   node companion/cli.js upload   [--sv <AuctionLens.lua>] [--force]
//     (skips a market with no scan since your last upload, unless --force)
//   node companion/cli.js download [--days 30]
//   node companion/cli.js sync         (upload, then download)
//   node companion/cli.js status
//   node companion/cli.js leave
//
// The work itself is server/lib/sync/client.js, shared with the Overwolf app.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import * as client from "../server/lib/sync/client.js";
import { nodeEnv } from "./nodeenv.js";

export { nodeEnv };

const CONFIG_DIR = process.env.APPDATA ? join(process.env.APPDATA, "AuctionLensCompanion")
    : join(homedir(), ".config", "auctionlens-companion");
const CONFIG_FILE = process.env.AUCTIONLENS_COMPANION_CONFIG || join(CONFIG_DIR, "config.json");

// Kept for tests and scripts written against the first CLI.
export const upload = (cfg, opt, log = console.log) => client.upload(nodeEnv, cfg, opt, log).then((s) => s.items);
export const download = (cfg, opt, log = console.log) => client.download(nodeEnv, cfg, opt, log);

function loadConfig() {
    try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function parseArgs(argv) {
    const pos = [], opt = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
        else pos.push(argv[i]);
    }
    return { pos, opt };
}

/** [server, rest...]: the first argument if it is an address, else the saved or default one. */
function withServer(pos, cfg) {
    if (/^https?:\/\//i.test(pos[0] || "")) return pos;
    return [cfg.server || client.DEFAULT_SERVER, ...pos];
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const { pos, opt } = parseArgs(rest);
    const cfg = loadConfig();
    switch (cmd) {
        case "create": {
            const [server, name] = withServer(pos, cfg);
            if (!name) throw new Error('usage: create [server] "<guild name>" [--label <you>] [--secret <s>]');
            const r = await client.createGroup(nodeEnv, server, name, opt.label, opt.secret);
            saveConfig({ ...cfg, server, token: r.token, group: r.group });
            console.log(`created "${r.group}". Guild-mates join with:\n  node companion/cli.js join ${server} ${r.joinCode}`);
            break;
        }
        case "join": {
            const [server, code] = withServer(pos, cfg);
            if (!code) throw new Error("usage: join [server] <JOIN-CODE> [--label <you>]");
            const r = await client.joinGroup(nodeEnv, server, code, opt.label);
            saveConfig({ ...cfg, server, token: r.token, group: r.group });
            console.log(`joined "${r.group}"`);
            break;
        }
        case "config": {
            if (opt.wow) cfg.wow = opt.wow;
            if (opt.server) cfg.server = opt.server;
            saveConfig(cfg);
            console.log({ ...cfg, token: cfg.token ? "(set)" : null }, "\nsaved to", CONFIG_FILE);
            if (cfg.wow && !existsSync(join(cfg.wow, "WTF")) && !existsSync(join(cfg.wow, "Interface"))) {
                console.log("note: that folder has no WTF or Interface folder - is it the _forever_ folder?");
            } else if (cfg.wow) {
                const accounts = existsSync(join(cfg.wow, "WTF", "Account")) ? readdirSync(join(cfg.wow, "WTF", "Account")) : [];
                console.log(`${accounts.length} account folder(s) found`);
            }
            break;
        }
        case "status": {
            const st = await client.status(nodeEnv, cfg);
            console.log(`group "${st.group}" (join code ${st.joinCode}), ${st.members} member(s)`);
            for (const m of st.markets) {
                console.log(`  ${m.market}: ${m.items} items from ${m.members} member(s), updated ${new Date(m.updated * 1000).toLocaleString()}`);
            }
            for (const u of st.uploads) console.log(`  you have sent ${u.market} through day ${u.throughDay}`);
            break;
        }
        case "upload": await upload(cfg, opt); break;
        case "download": {
            await download(cfg, opt);
            console.log("/reload in game to load it (a new addon folder needs a client restart once)");
            break;
        }
        case "sync": {
            await upload(cfg, opt);
            await download(cfg, opt);
            console.log("/reload in game to load it (a new addon folder needs a client restart once)");
            break;
        }
        case "leave": {
            await client.leave(nodeEnv, cfg);
            saveConfig({ ...cfg, token: null, group: null });
            console.log("left the group");
            break;
        }
        default:
            console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n"));
    }
}

if (process.argv[1] && /cli\.js$/.test(process.argv[1])) {
    main().catch((e) => {
        console.error("error:", e.message);
        process.exitCode = 1;
    });
}
