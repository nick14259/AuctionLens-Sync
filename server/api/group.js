// POST /api/group  { name, label? }  ->  { group, joinCode, token }
// Creates a guild group; the creator is its first member. If CREATE_SECRET is set on
// the deployment, the request must carry it in an x-create-secret header, so a private
// deployment is not open to anyone who finds the URL.
import { route, readJson, preflight } from "../lib/http.js";
import { ApiError, createGroup } from "../lib/store.js";

export const POST = route(async ({ request, query }) => {
    const secret = process.env.CREATE_SECRET;
    if (secret && request.headers.get("x-create-secret") !== secret) {
        throw new ApiError(403, "this server needs a create secret to make groups");
    }
    const body = await readJson(request);
    return createGroup(query, body.name, body.label);
});

export const OPTIONS = preflight;
