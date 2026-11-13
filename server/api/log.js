// POST /api/log  { code }  ->  the group's members, markets and recent uploads, for the
// scan log page (public/index.html). The join code is the key: whoever may join may look.
// POST, so the code stays out of URLs and request logs.
import { route, readJson, preflight } from "../lib/http.js";
import { scanLog } from "../lib/store.js";

export const POST = route(async ({ request, query }) => scanLog(query, (await readJson(request)).code));

export const OPTIONS = preflight;
