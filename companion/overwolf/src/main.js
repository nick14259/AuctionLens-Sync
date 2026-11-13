// The app's window. It holds no state of its own: everything lives in the background
// page's controller (window.alens there), which keeps running when this window closes.

/* global overwolf */
const bg = overwolf.windows.getMainWindow();
const ctl = bg.alens;
const $ = (id) => document.getElementById(id);

let windowId = null;
overwolf.windows.getCurrentWindow((r) => { if (r && r.success) windowId = r.window.id; });

// ---------------------------------------------------------------------------
// Window chrome
// ---------------------------------------------------------------------------
$("titlebar").addEventListener("mousedown", (e) => {
    if (e.target.closest("button") || windowId === null) return;
    overwolf.windows.dragMove(windowId);
});
$("btn-min").onclick = () => windowId !== null && overwolf.windows.minimize(windowId, () => {});
$("btn-close").onclick = () => windowId !== null && overwolf.windows.close(windowId, () => {});
$("btn-quit").onclick = () => {
    if (confirm("Quit AuctionLens Guild Sync? Nothing syncs until you start it again.")) bg.alensQuit();
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function ago(t) {
    if (!t) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}
const count = (n) => (Number(n) || 0).toLocaleString("en-US");
function clock(t) {
    const d = new Date(t);
    return d.toTimeString().slice(0, 8);
}
function setText(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = cls || "";
}

// ---------------------------------------------------------------------------
// Connect (join / create)
// ---------------------------------------------------------------------------
let mode = "join";
function setMode(m) {
    mode = m;
    $("tab-join").classList.toggle("on", m === "join");
    $("tab-create").classList.toggle("on", m === "create");
    $("pane-join").hidden = m !== "join";
    $("pane-create").hidden = m !== "create";
    $("btn-connect").textContent = m === "join" ? "JOIN" : "CREATE GROUP";
}
$("tab-join").onclick = () => setMode("join");
$("tab-create").onclick = () => setMode("create");

$("btn-connect").onclick = async () => {
    const server = $("in-server").value.trim();
    const label = $("in-label").value.trim();
    if (!/^https?:\/\/\S+$/.test(server)) return ctlLogHint("enter the server address, like https://your-project.vercel.app");
    if (mode === "join") {
        const code = $("in-code").value.trim();
        if (!code) return ctlLogHint("enter the join code a guild-mate gave you");
        await ctl.join(server, code, label);
    } else {
        const name = $("in-name").value.trim();
        if (!name) return ctlLogHint("give the group a name");
        await ctl.create(server, name, label, $("in-secret").value.trim() || undefined);
    }
};
function ctlLogHint(text) {
    const li = document.createElement("li");
    li.innerHTML = "<time></time><span class=\"err\"></span>";
    li.querySelector("time").textContent = clock(Date.now());
    li.querySelector("span").textContent = text;
    $("log").appendChild(li);
    $("log").scrollTop = $("log").scrollHeight;
}

// ---------------------------------------------------------------------------
// Folder, options, actions
// ---------------------------------------------------------------------------
$("in-wow").addEventListener("change", () => ctl.setConfig({ wow: $("in-wow").value.trim() }));
$("btn-browse").onclick = () => {
    overwolf.utils.openFolderPicker($("in-wow").value || "C:\\", (r) => {
        if (r && r.success && r.path) {
            $("in-wow").value = r.path;
            ctl.setConfig({ wow: r.path });
        }
    });
};
$("opt-up").onchange = () => ctl.setConfig({ autoUpload: $("opt-up").checked });
$("opt-down").onchange = () => ctl.setConfig({ autoDownload: $("opt-down").checked });
$("btn-sync").onclick = () => ctl.syncNow();
$("btn-leave").onclick = () => {
    if (confirm("Leave this group? Your uploads stay in the guild's data; you can join again with the code.")) ctl.leave();
};
$("btn-code").onclick = () => {
    const code = $("ro-code").textContent;
    if (code && overwolf.utils.placeOnClipboard) {
        overwolf.utils.placeOnClipboard(code);
        $("btn-code").firstChild.textContent = "COPIED ";
        setTimeout(() => { $("btn-code").firstChild.textContent = "CODE "; }, 1500);
    }
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let shownLog = 0;
function render(s) {
    const c = s.config;
    $("connect").hidden = s.joined;
    $("readout").hidden = !s.joined;
    $("options").hidden = !s.joined;
    $("btn-leave").hidden = !s.joined;
    $("log-num").textContent = s.joined ? "04" : "03";
    if (!s.joined && !$("in-server").value && c.server) $("in-server").value = c.server;

    // Busy state on whichever button started it.
    const busy = !!s.busy;
    const connect = $("btn-connect");
    connect.disabled = busy;
    connect.classList.toggle("busy", s.busy === "join" || s.busy === "create");
    const sync = $("btn-sync");
    sync.disabled = busy || !s.ready;
    sync.classList.toggle("busy", s.busy === "sync" || s.busy === "download");
    sync.textContent = s.busy === "sync" ? "SYNCING..." : s.busy === "download" ? "FETCHING GUILD DATA..."
        : s.ready ? "SYNC NOW" : "CHOOSE THE WOW FOLDER FIRST";

    if (s.joined) {
        setText("ro-group", c.group || "...");
        setText("ro-members", s.members ? `${s.members} member${s.members === 1 ? "" : "s"}` : "", "muted");
        setText("ro-code", c.joinCode || "", "mono");
        const l = s.last;
        if (!l) setText("ro-last", "never");
        else if (l.ok) {
            const parts = [ago(l.time)];
            if (l.upToDate) parts.push("up to date, nothing to send or fetch");
            else {
                if (l.uploaded !== undefined) parts.push(`sent ${count(l.uploaded)}`);
                if (l.downloaded !== undefined) parts.push(`received ${count(l.downloaded)}`);
            }
            setText("ro-last", parts.join(" \u00b7 "), "ok");
        } else setText("ro-last", `failed ${ago(l.time)}: ${l.message || ""}`, "bad");
        setText("ro-game", s.game.running ? "running" : "not running", s.game.running ? "ok" : "");
        if (s.busy) setText("ro-next", `${s.busy}...`, "warn");
        else if (s.scheduled) {
            const secs = Math.max(0, Math.round((s.scheduled.at - Date.now()) / 1000));
            setText("ro-next", `sync in ${secs} s (${s.scheduled.reason})`, "warn");
        } else setText("ro-next", c.autoUpload ? "after the game next saves" : "when you press Sync now");
        $("opt-up").checked = !!c.autoUpload;
        $("opt-down").checked = !!c.autoDownload;
    }

    // Folder
    if (document.activeElement !== $("in-wow")) $("in-wow").value = c.wow || "";
    const ws = $("wow-status");
    if (!c.wow) { ws.textContent = "Choose the _forever_ folder, or start the game once and it is found."; ws.className = "muted small"; }
    else if (s.accounts.length) {
        ws.textContent = `AuctionLens data found for ${s.accounts.length} account${s.accounts.length === 1 ? "" : "s"}.`;
        ws.className = "small ok";
    } else if (s.wowOk) {
        ws.textContent = "No AuctionLens data here yet - log in once with AuctionLens enabled.";
        ws.className = "small warn";
    } else {
        ws.textContent = "This does not look like a WoW folder: pick the one with Wow.exe, WTF and Interface in it.";
        ws.className = "small bad";
    }

    // Log: append what is new (entries carry a sequence number; old ones are trimmed).
    const log = $("log");
    const fresh = s.log.filter((e) => e.n > shownLog);
    for (const entry of fresh) {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = clock(entry.t);
        const m = document.createElement("span");
        m.textContent = entry.msg;
        if (/failed|cannot|error|no longer/i.test(entry.msg)) m.className = "err";
        li.append(t, m);
        log.appendChild(li);
    }
    if (fresh.length) {
        shownLog = fresh[fresh.length - 1].n;
        while (log.children.length > 200) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
    }
}

const unsubscribe = ctl.subscribe(render);
window.addEventListener("beforeunload", unsubscribe);
// The countdown and "x min ago" move on their own. (The desktop app's first snapshot
// arrives asynchronously: nothing to draw until it has.)
setInterval(() => {
    const s = ctl.snapshot();
    if (s) render(s);
}, 1000);
