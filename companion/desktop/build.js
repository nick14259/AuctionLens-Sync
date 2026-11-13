// Prepares companion/desktop/app: everything the Electron app needs, in one folder that
// electron-builder packs into a portable exe (see builder.json, `npm run dist`).
//
//   app/main.cjs        src/main.js bundled with the controller and sync code (esbuild)
//   app/preload.cjs     the window's bridge
//   app/ui/             the Overwolf app's window, unchanged, plus shim.js
//   app/icons/          drawn by companion/icons.js
//   build-res/icon.ico  the exe's icon

import { build } from "esbuild";
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { draw, ico } from "../icons.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const ow = join(here, "..", "overwolf");
const app = join(here, "app");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

rmSync(app, { recursive: true, force: true });
for (const d of ["ui/js", "ui/fonts", "icons"]) mkdirSync(join(app, d), { recursive: true });
mkdirSync(join(here, "build-res"), { recursive: true });

await build({
    entryPoints: [join(here, "src", "main.js")],
    outfile: join(app, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    legalComments: "none",
    logLevel: "warning",
});
copyFileSync(join(here, "src", "preload.cjs"), join(app, "preload.cjs"));

// The window: the Overwolf app's, with the shim loaded first.
const html = readFileSync(join(ow, "static", "main.html"), "utf8")
    .replace('<script src="js/main.js"></script>', '<script src="js/shim.js"></script>\n<script src="js/main.js"></script>')
    .replace("<head>", "<head>\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'\">");
writeFileSync(join(app, "ui", "main.html"), html);
copyFileSync(join(ow, "static", "main.css"), join(app, "ui", "main.css"));
copyFileSync(join(ow, "src", "main.js"), join(app, "ui", "js", "main.js"));
copyFileSync(join(here, "static", "shim.js"), join(app, "ui", "js", "shim.js"));
const fonts = join(repo, "AuctionLens", "Media", "Fonts");
for (const f of ["ChakraPetch-SemiBold.ttf", "ShareTechMono-Regular.ttf", "OFL-ChakraPetch.txt", "OFL-ShareTechMono.txt"]) {
    copyFileSync(join(fonts, f), join(app, "ui", "fonts", f));
}

writeFileSync(join(app, "icons", "icon.png"), draw(256, false));
writeFileSync(join(app, "icons", "tray.ico"), ico([16, 24, 32, 48].map((size) => ({ size, data: draw(size, false) }))));
writeFileSync(join(here, "build-res", "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: draw(size, false) }))));

// The packaged app's own package.json (electron-builder's two-package layout).
writeFileSync(join(app, "package.json"), JSON.stringify({
    name: "auctionlens-sync",
    productName: "AuctionLens Sync",
    version: pkg.version,
    description: "Shares AuctionLens auction house prices within your WoW guild.",
    author: "Jarnot",
    license: "UNLICENSED",
    main: "main.cjs",
}, null, 2));

console.log("prepared", app);
