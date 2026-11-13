// POST /api/join  { code, label? }  ->  { group, token }
import { route, readJson, preflight } from "../lib/http.js";
import { joinGroup } from "../lib/store.js";

export const POST = route(async ({ request, query }) => {
    const body = await readJson(request);
    return joinGroup(query, body.code, body.label);
});

export const OPTIONS = preflight;
