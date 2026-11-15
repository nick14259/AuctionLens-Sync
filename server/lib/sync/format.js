// What the addon's history fields mean, per SavedVariables schema (AuctionLens/Data/DB.lua
// DB.SCHEMA, layouts in Data/History.lua). A schema this file does not know is refused,
// not guessed at: a new one is added here when the addon's storage changes.

/** Newest point (rec.l, absolute) and intraday points (rec.p). */
export const P = { T: 0, MIN: 1, MKT: 2, QTY: 3, N: 4, SOLD: 5, DEPTH: 6 };
/** Daily rows (rec.d, delta-coded). */
export const D = { DAY: 0, OPEN: 1, HIGH: 2, LOW: 3, CLOSE: 4, FLOOR: 5, AVGQ: 6, MAXQ: 7, SOLD: 8, SCANS: 9 };

export const SCHEMAS = {
    3: {
        pWidth: 7,
        dWidth: 10,
        // History.D_DELTA = [1..8] in Lua, 0-based here.
        dDelta: new Set([0, 1, 2, 3, 4, 5, 6, 7]),
    },
};

/** Wire format version of the upload/download bodies (not the addon's storage schema). */
export const WIRE = 1;

export function layout(schema) {
    const s = SCHEMAS[schema];
    if (!s) throw new Error(`unsupported AuctionLens storage schema ${schema}`);
    return s;
}

/** Days since the Unix epoch, as Util.DayIndex counts them (UTC). */
export function dayIndex(t) {
    return Math.floor(t / 86400);
}

/** Market keys look like "US-RealmName-Horde"; realm names may hold any byte but these. */
export function validMarket(m) {
    return typeof m === "string" && m.length >= 5 && m.length <= 120 && !/[\u0000-\u001f"\\]/.test(m);
}

/**
 * A market key as the addon builds it since 0.3.1 (Market.RulesetOf in Core/Market.lua):
 * Forever's realm name carries the server's number, which differs between players on one
 * auction house, so it is dropped - "US-CAMWOWUS2Realm6PvP-Horde" is "US-CAMWOWUS2PvP-Horde".
 * Keys from 0.3.0 and earlier still arrive; anything else passes unchanged.
 */
export function canonicalMarket(m) {
    const k = /^([^-]+)-([^-]+)-([^-]+)$/.exec(m);
    if (!k) return m;
    const r = /^(.*?)Realm[0-9]+([A-Za-z].*)$/.exec(k[2]);
    return r ? `${k[1]}-${r[1]}${r[2]}-${k[3]}` : m;
}

/** Item keys: "1234", "1234:b5678", "1234:s12:b5.6" and the like. */
export function validItemKey(k) {
    return typeof k === "string" && /^[0-9]{1,9}(:[a-z0-9.:-]{1,60})?$/.test(k);
}

/** Codec text: base-36 digits, signs and separators only. */
export function validCodec(s, max) {
    return typeof s === "string" && s.length <= max && /^[0-9a-z,;-]*$/.test(s);
}
