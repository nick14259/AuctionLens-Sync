// GET /api/download?market=..&days=30&after=<itemKey>  (Bearer token)
// One page of the guild's merged data for a market; follow `next` until it is null.
import { route, preflight } from "../lib/http.js";
import { download } from "../lib/store.js";

export const GET = route(({ query, member, url }) =>
    download(query, member, Object.fromEntries(url.searchParams)), { auth: true });

export const OPTIONS = preflight;
