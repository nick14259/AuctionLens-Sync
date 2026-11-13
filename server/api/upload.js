// POST /api/upload  (Bearer token)  { v, schema, market, lastScan, items, complete?, throughDay? }
// One batch of a market; see lib/sync/payload.js for the shape.
import { route, readJson, preflight } from "../lib/http.js";
import { upload } from "../lib/store.js";

export const POST = route(async ({ request, query, member }) =>
    upload(query, member, await readJson(request)), { auth: true });

export const OPTIONS = preflight;
