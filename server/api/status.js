// GET /api/status  (Bearer token)  ->  the group, its markets, and how far this
// member's uploads reach per market.
import { route, preflight } from "../lib/http.js";
import { status } from "../lib/store.js";

export const GET = route(({ query, member }) => status(query, member), { auth: true });

export const OPTIONS = preflight;
