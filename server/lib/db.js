// The database connection. On Vercel, DATABASE_URL comes from the Neon integration
// (Vercel > Storage > Create > Neon, connected to this project). Tests and dev.js swap
// in PGlite with setQuery.

import { neon } from "@neondatabase/serverless";

let query = null;

export function getQuery() {
    if (query) return query;
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set - connect a Neon database to the Vercel project");
    const sql = neon(url);
    query = (text, params = []) => sql.query(text, params);
    return query;
}

export function setQuery(fn) {
    query = fn;
}
