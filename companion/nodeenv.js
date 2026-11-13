// Files and network for server/lib/sync/client.js, from Node: used by the command-line
// companion and the desktop app (companion/desktop).

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";

export const nodeEnv = {
    readText: (p) => readFile(p, "utf8"),
    // Write then rename: a /reload that reads the file mid-write sees the old one whole,
    // never half of the new one.
    writeText: async (p, text) => {
        await mkdir(dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        await writeFile(tmp, text, "utf8");
        await rename(tmp, p);
    },
    exists: async (p) => existsSync(p),
    listDir: async (p) => {
        try { return await readdir(p); } catch { return []; }
    },
    join,
    fetch: (...a) => fetch(...a),
};
