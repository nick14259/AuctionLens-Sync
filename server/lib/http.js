// Request plumbing shared by every function in api/: JSON in and out, CORS for the
// Overwolf app (its pages run on an overwolf-extension:// origin), bearer tokens, and
// errors that say what went wrong without leaking a stack.

import { getQuery } from "./db.js";
import { ApiError, authenticate } from "./store.js";

const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-create-secret",
    "access-control-max-age": "86400",
};

export function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
    });
}

export function preflight() {
    return new Response(null, { status: 204, headers: CORS });
}

export function bearer(request) {
    const h = request.headers.get("authorization") || "";
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m ? m[1] : null;
}

const MAX_BODY = 4_400_000;

export async function readJson(request) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_BODY) throw new ApiError(413, "body too large - send smaller batches");
    const text = await request.text();
    if (text.length > MAX_BODY) throw new ApiError(413, "body too large - send smaller batches");
    try {
        return JSON.parse(text);
    } catch {
        throw new ApiError(400, "body is not JSON");
    }
}

/**
 * Wraps a handler: fn(ctx) where ctx = { request, query, member?, url }. `auth: true`
 * resolves the bearer token to a member first.
 */
export function route(fn, { auth = false } = {}) {
    return async (request) => {
        try {
            const query = getQuery();
            const ctx = { request, query, url: new URL(request.url) };
            if (auth) ctx.member = await authenticate(query, bearer(request));
            return json(200, await fn(ctx));
        } catch (e) {
            if (e instanceof ApiError) return json(e.status, { error: e.message });
            console.error(e);
            return json(500, { error: "server error" });
        }
    };
}
