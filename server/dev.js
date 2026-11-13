// Local stand-in for Vercel: serves api/*.js on http://localhost:3000 against PGlite
// (Postgres compiled to WebAssembly), so the whole round trip can be tried without an
// account anywhere.
//
//   node dev.js               data kept in server/.data/ between runs
//   node dev.js --memory      throwaway database
//   PORT=4000 node dev.js
//
// Not used in production: Vercel runs api/*.js itself, against Neon.

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setQuery } from "./lib/db.js";

export async function startDev({ port = 3000, memory = false, quiet = false } = {}) {
    const pg = memory ? new PGlite() : new PGlite(fileURLToPath(new URL("./.data", import.meta.url)));
    await pg.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    setQuery(async (text, params = []) => (await pg.query(text, params)).rows);

    const routes = {};
    for (const name of readdirSync(new URL("./api/", import.meta.url)).filter((f) => f.endsWith(".js"))) {
        routes[name.slice(0, -3)] = await import(`./api/${name}`);
    }

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://localhost:${port}`);
            // Vercel serves public/ as static files; so does this.
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                return res.end(readFileSync(new URL("./public/index.html", import.meta.url)));
            }
            const m = /^\/api\/([a-z]+)$/.exec(url.pathname);
            const mod = m && routes[m[1]];
            const fn = mod && mod[req.method];
            if (!fn) {
                res.writeHead(404, { "content-type": "application/json" });
                return res.end(JSON.stringify({ error: "not found" }));
            }
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const body = chunks.length ? Buffer.concat(chunks) : undefined;
            const request = new Request(url, {
                method: req.method,
                headers: req.headers,
                body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
            });
            const response = await fn(request);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
            if (!quiet) console.log(req.method, url.pathname, response.status);
        } catch (e) {
            console.error(e);
            res.writeHead(500);
            res.end();
        }
    });
    await new Promise((done) => server.listen(port, done));
    return {
        server, pg,
        port: server.address().port,
        close: () => new Promise((r) => server.close(() => pg.close().then(r))),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT) || 3000;
    await startDev({ port, memory: process.argv.includes("--memory") });
    console.log(`AuctionLens guild server on http://localhost:${port}/api/...`);
}
