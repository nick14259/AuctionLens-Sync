// POST /api/leave  (Bearer token)  ->  forgets this member. Their uploads stay merged.
import { route, preflight } from "../lib/http.js";
import { leave } from "../lib/store.js";

export const POST = route(({ query, member }) => leave(query, member), { auth: true });

export const OPTIONS = preflight;
