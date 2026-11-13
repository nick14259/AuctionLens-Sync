// Files and network for server/lib/sync/client.js, from Node: used by the command-line
// companion and the desktop app (companion/desktop).

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export const nodeEnv = {
    readText: (p) => readFile(p, "utf8"),
    writeText: async (p, text) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, text, "utf8");
    },
    exists: async (p) => existsSync(p),
    listDir: async (p) => {
        try { return await readdir(p); } catch { return []; }
    },
    join,
    fetch: (...a) => fetch(...a),
};
