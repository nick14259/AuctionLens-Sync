// Files and network for server/lib/sync/client.js, from Overwolf's APIs.
// Reference: dev.overwolf.com/ow-native/reference/io/ow-io (FileSystem permission).
//
// - readTextFile reads the whole file as UTF-8 (maxBytesToRead 0 = all of it).
// - writeFileContents creates the file "along with any required directories".
// - exist works for folders and files; dir lists names and types.

/** Windows path join: one backslash between parts, forward slashes turned around. */
export function winJoin(...parts) {
    return parts
        .filter((p) => p !== undefined && p !== null && p !== "")
        .map((p, i) => {
            const s = String(p).replace(/\//g, "\\");
            return i === 0 ? s.replace(/\\+$/, "") : s.replace(/^\\+|\\+$/g, "");
        })
        .join("\\");
}

/** The folder a file path is in. */
export function winDirname(p) {
    const s = String(p || "").replace(/\//g, "\\").replace(/\\+$/, "");
    const i = s.lastIndexOf("\\");
    return i > 0 ? s.slice(0, i) : s;
}

/** Same folder, however it is spelled: case, slash direction and a trailing slash. */
export function samePath(a, b) {
    const norm = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    return norm(a) !== "" && norm(a) === norm(b);
}

export function makeOverwolfEnv(ow, fetchFn) {
    const io = ow.io;
    const UTF8 = (io.enums && io.enums.eEncoding && io.enums.eEncoding.UTF8) || "UTF8";
    const call = (fn, ...args) => new Promise((resolve) => fn(...args, resolve));
    return {
        async readText(path) {
            const r = await call(io.readTextFile, path, { encoding: UTF8, maxBytesToRead: 0, offset: 0 });
            if (!r || !r.success) throw new Error(`cannot read ${path}: ${(r && r.error) || "unknown error"}`);
            return r.content;
        },
        async writeText(path, text) {
            const r = await call(io.writeFileContents, path, text, UTF8, false);
            if (!r || !r.success) throw new Error(`cannot write ${path}: ${(r && r.error) || "unknown error"}`);
        },
        async exists(path) {
            const r = await call(io.exist, path);
            return !!(r && r.success && r.exist);
        },
        async listDir(path) {
            const r = await call(io.dir, path);
            if (!r || !r.success || !Array.isArray(r.data)) return [];
            return r.data.map((f) => f.name);
        },
        join: winJoin,
        fetch: fetchFn,
    };
}
