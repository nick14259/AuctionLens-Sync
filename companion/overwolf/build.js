// Builds the Overwolf app into dist/overwolf/AuctionLensCompanion, ready to load unpacked
// (Overwolf > Settings > About > Development options > Load unpacked extension).
//
//   cd companion/overwolf && npm install && npm run build
//
// - src/*.js are bundled with esbuild into js/*.js (one plain script each: no ES modules
//   at runtime, so nothing depends on how Overwolf serves module scripts)
// - static/ is copied as is
// - fonts come from the addon (AuctionLens/Media/Fonts, SIL OFL - licences copied along)
// - icons are drawn here, so no binary files live in the repo

import { build } from "esbuild";
import { mkdirSync, rmSync, cpSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { draw, ico } from "../icons.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const out = process.env.OUT || join(repo, "dist", "overwolf", "AuctionLensCompanion");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "js"), { recursive: true });

// 1. Scripts
await build({
    entryPoints: { background: join(here, "src", "background.js"), main: join(here, "src", "main.js") },
    outdir: join(out, "js"),
    bundle: true,
    format: "iife",
    target: "chrome100",
    legalComments: "none",
    logLevel: "warning",
});

// 2. Static files
for (const f of readdirSync(join(here, "static"))) cpSync(join(here, "static", f), join(out, f), { recursive: true });

// 3. Fonts
const fonts = join(repo, "AuctionLens", "Media", "Fonts");
mkdirSync(join(out, "fonts"), { recursive: true });
for (const f of ["ChakraPetch-SemiBold.ttf", "ShareTechMono-Regular.ttf", "OFL-ChakraPetch.txt", "OFL-ShareTechMono.txt"]) {
    copyFileSync(join(fonts, f), join(out, "fonts", f));
}

// 4. Icons (companion/icons.js)
mkdirSync(join(out, "icons"), { recursive: true });
writeFileSync(join(out, "icons", "icon.png"), draw(256, false));
writeFileSync(join(out, "icons", "icon_gray.png"), draw(256, true));
writeFileSync(join(out, "icons", "window_icon.png"), draw(256, false));
writeFileSync(join(out, "icons", "launcher.ico"), ico([16, 32, 48, 256].map((size) => ({ size, data: draw(size, false) }))));

console.log("built", out);
