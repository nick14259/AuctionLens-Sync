// AuctionLens Sync, desktop edition (Electron): the Overwolf app's controller and window
// in a single portable exe that lives in the system tray. For sharing with guild-mates
// until the Overwolf app is approved - and for anyone who would rather not run Overwolf.
//
//   --hidden   start in the tray (used by "Start with Windows")
//   --smoke    build check: load the window hidden, report, exit (no tray, no polling)

import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard, nativeImage, Notification } from "electron";
import { join } from "node:path";
import { createController } from "../../overwolf/src/controller.js";
import { nodeEnv } from "../../nodeenv.js";
import { fileStorage, seedFromCli, nodeWatcher, gamePoller, cliConfigPath } from "./host.js";

const SMOKE = process.argv.includes("--smoke");
const HIDDEN = process.argv.includes("--hidden");
const APP_ID = "com.auctionlens.sync";
const TITLE = "AuctionLens Sync";
// The window's calls into the controller.
const METHODS = new Set(["snapshot", "syncNow", "downloadNow", "setConfig", "join", "create", "leave", "refreshWatches"]);

let win = null, tray = null, ctl = null, poller = null, storage = null;
let quitting = false;

// The portable exe unpacks to a temp folder on every start; Windows must launch the
// real file at login, which electron-builder names here.
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const loginArgs = ["--hidden"];

function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function hideToTray() {
    if (!win) return;
    win.hide();
    if (tray && storage && !storage.getItem("desktop.trayHint")) {
        storage.setItem("desktop.trayHint", "1");
        tray.displayBalloon({
            title: TITLE,
            content: "Still syncing in the background. Click the tray icon to open it, right-click to quit.",
        });
    }
}

function quit() {
    quitting = true;
    if (poller) poller.stop();
    app.quit();
}

function createWindow() {
    win = new BrowserWindow({
        width: 480, height: 720, minWidth: 400, minHeight: 520,
        frame: false, show: false, backgroundColor: "#0b0c0f", title: TITLE,
        icon: join(__dirname, "icons", "icon.png"),
        webPreferences: {
            preload: join(__dirname, "preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });
    win.removeMenu();
    win.loadFile(join(__dirname, "ui", "main.html"));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => { if (!HIDDEN && !SMOKE) win.show(); });
    win.on("close", (e) => {
        if (quitting) return;
        e.preventDefault();
        hideToTray();
    });
    win.on("minimize", (e) => {
        e.preventDefault();
        hideToTray();
    });
}

function loginItem(on) {
    const opts = { path: exePath(), args: loginArgs };
    if (on === undefined) return app.getLoginItemSettings(opts).openAtLogin;
    app.setLoginItemSettings({ ...opts, openAtLogin: on });
    return on;
}

function trayMenu(snap) {
    const busy = snap && snap.busy;
    return Menu.buildFromTemplate([
        { label: "Open AuctionLens Sync", click: showWindow },
        { label: busy ? "Syncing..." : "Sync now", enabled: !busy && !!(snap && snap.ready), click: () => ctl.syncNow() },
        { type: "separator" },
        { label: "Start with Windows", type: "checkbox", checked: loginItem(), click: (item) => loginItem(item.checked) },
        { type: "separator" },
        { label: "Quit", click: quit },
    ]);
}

function trayTip(snap) {
    if (!snap || !snap.joined) return `${TITLE} - not in a group yet`;
    if (snap.busy) return `${TITLE} - ${snap.busy}...`;
    const l = snap.last;
    if (!l) return `${TITLE} - ${snap.config.group || "group"} - not synced yet`;
    const mins = Math.round((Date.now() - l.time) / 60000);
    const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
    return `${TITLE} - ${snap.config.group || "group"} - ${l.ok ? "synced" : "sync failed"} ${when}`;
}

function createTray() {
    tray = new Tray(nativeImage.createFromPath(join(__dirname, "icons", "tray.ico")));
    tray.setToolTip(TITLE);
    tray.on("click", showWindow);
    tray.setContextMenu(trayMenu(ctl.snapshot()));
}

let lastNotified = null;
function onSnapshot(snap) {
    if (win && !win.isDestroyed()) win.webContents.send("alens:snapshot", snap);
    if (tray) {
        tray.setToolTip(trayTip(snap).slice(0, 127));
        tray.setContextMenu(trayMenu(snap));
    }
    // A failed sync in the background would go unseen in the tray: say so, once each.
    const l = snap.last;
    if (l && !l.ok && l.time !== lastNotified && !SMOKE && Notification.isSupported()) {
        lastNotified = l.time;
        const n = new Notification({ title: "AuctionLens sync failed", body: String(l.message || "").slice(0, 200) });
        n.on("click", showWindow);
        n.show();
    }
}

function wireIpc() {
    ipcMain.handle("alens:call", (_e, method, args) => {
        if (!METHODS.has(method)) throw new Error(`unknown call ${method}`);
        return ctl[method](...(Array.isArray(args) ? args : []));
    });
    ipcMain.handle("alens:browse", async (_e, initial) => {
        const r = await dialog.showOpenDialog(win, {
            title: "Choose the WoW: Forever folder (the one with Wow.exe in it)",
            defaultPath: initial || undefined,
            properties: ["openDirectory"],
        });
        return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    });
    ipcMain.on("alens:window", (_e, action) => {
        if (action === "minimize" || action === "close") hideToTray();
        else if (action === "quit") quit();
    });
    ipcMain.on("alens:copy", (_e, text) => clipboard.writeText(String(text)));
    ipcMain.on("alens:ready", async (_e, info) => {
        if (!SMOKE) return;
        // SMOKE_SHOT=<file.png>: what the window drew, for checking the build by eye.
        if (process.env.SMOKE_SHOT) {
            const { writeFileSync } = await import("node:fs");
            await new Promise((r) => setTimeout(r, 400));
            writeFileSync(process.env.SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
        }
        process.stdout.write(`SMOKE OK ${JSON.stringify(info)}\n`);
        quitting = true;
        app.exit(0);
    });
}

if (!app.requestSingleInstanceLock()) {
    // Already running: the first instance shows its window (second-instance below).
    app.quit();
} else {
    app.on("second-instance", showWindow);
    app.setAppUserModelId(APP_ID);
    app.whenReady().then(async () => {
        // A smoke run keeps its settings apart from the real ones.
        const dataDir = SMOKE ? join(app.getPath("temp"), "auctionlens-sync-smoke") : app.getPath("userData");
        storage = fileStorage(join(dataDir, "settings.json"));
        seedFromCli(storage, cliConfigPath());
        ctl = createController({ ow: { io: nodeWatcher() }, env: nodeEnv, storage });
        wireIpc();
        createWindow();
        if (!SMOKE) createTray();
        ctl.subscribe(onSnapshot);
        await ctl.start();
        if (!SMOKE) poller = gamePoller(ctl);
        if (SMOKE) setTimeout(() => { process.stdout.write("SMOKE TIMEOUT\n"); app.exit(1); }, 20000);
    });
    // Closing the window hides it; only Quit ends the app.
    app.on("window-all-closed", () => {});
    app.on("before-quit", () => { quitting = true; });
}
