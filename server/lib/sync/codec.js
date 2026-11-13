// A port of AuctionLens/Data/Codec.lua: the compact text the addon stores history in.
//
//   Numbers : integers in base 36, "-" for negative ("" = nil / unknown)
//   Fields  : separated by ","
//   Rows    : separated by ";"
//
// Delta-coded rows store, for the fields in `deltaFields`, the first non-nil value
// absolute and every later one as the difference from the previous non-nil value of
// that field. Output must match the Lua encoder byte for byte: the addon reads what
// the server writes (tests/node/codec.test.js checks against strings Lua encoded).
//
// Shared by the Vercel functions and the companion; plain ES modules, no dependencies.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Lua's floor(n + 0.5). */
function round(n) {
    return Math.floor(n + 0.5);
}

export function encodeInt(n) {
    if (n === null || n === undefined) return "";
    n = round(n);
    if (n === 0) return "0";
    const s = Math.abs(n).toString(36);
    return n < 0 ? "-" + s : s;
}

export function decodeInt(s) {
    if (s === undefined || s === null || s === "") return null;
    let neg = false;
    let i = 0;
    if (s[0] === "-") { neg = true; i = 1; }
    if (i >= s.length) return null;
    let n = 0;
    for (; i < s.length; i++) {
        const d = DIGITS.indexOf(s[i]);
        if (d < 0) return null;
        n = n * 36 + d;
    }
    return neg ? -n : n;
}

/** One absolute row: `width` fields, nil written as "". */
export function encodeRow(row, width) {
    const out = new Array(width);
    for (let i = 0; i < width; i++) out[i] = encodeInt(row[i]);
    return out.join(",");
}

/** Decodes one absolute row; missing trailing fields are null. */
export function decodeRow(s, width) {
    const row = new Array(width).fill(null);
    if (!s) return row;
    const parts = s.split(",");
    for (let i = 0; i < width && i < parts.length; i++) row[i] = decodeInt(parts[i]);
    return row;
}

/**
 * Rows as the addon stores p/d. `deltaFields` is a Set of 0-based field indices
 * (the Lua sets are 1-based: History.D_DELTA [1..8] is 0..7 here).
 */
export function encodeDeltaRows(rows, width, deltaFields) {
    const ref = new Array(width).fill(null);
    const out = [];
    for (const row of rows) {
        const fields = new Array(width);
        for (let i = 0; i < width; i++) {
            let v = row[i];
            if (v !== null && v !== undefined && deltaFields.has(i)) {
                v = round(v);
                const base = ref[i];
                fields[i] = encodeInt(base === null ? v : v - base);
                ref[i] = v;
            } else {
                fields[i] = encodeInt(v);
            }
        }
        out.push(fields.join(","));
    }
    return out.join(";");
}

export function decodeDeltaRows(s, width, deltaFields) {
    const rows = [];
    if (!s) return rows;
    const ref = new Array(width).fill(null);
    for (const chunk of s.split(";")) {
        if (chunk === "") continue;
        const parts = chunk.split(",");
        const row = new Array(width).fill(null);
        for (let i = 0; i < width && i < parts.length; i++) {
            let v = decodeInt(parts[i]);
            if (v !== null && deltaFields.has(i)) {
                if (ref[i] !== null) v = ref[i] + v;
                ref[i] = v;
            }
            row[i] = v;
        }
        rows.push(row);
    }
    return rows;
}
