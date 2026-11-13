// Gives the Overwolf app's window script (main.js) the `overwolf` object it expects, built
// on the desktop app's bridge (preload.cjs). Loaded before main.js; same window, same code.
(function () {
    "use strict";
    var b = window.alensBridge;
    var last = null;
    var subs = [];
    var reported = false;

    b.onSnapshot(function (s) {
        last = s;
        subs.slice().forEach(function (fn) { fn(s); });
    });

    function reportReady() {
        if (reported) return;
        reported = true;
        setTimeout(function () {
            var g = document.getElementById("ro-group");
            b.ready({ joined: !!(last && last.joined), group: g ? g.textContent : "", brand: document.title });
        }, 150);
    }

    var ctl = {
        snapshot: function () { return last; },
        subscribe: function (fn) {
            subs.push(fn);
            var deliver = function (s) { if (s) { fn(s); reportReady(); } };
            if (last) deliver(last);
            else b.call("snapshot").then(function (s) { if (!last) last = s; deliver(last); });
            return function () { subs = subs.filter(function (f) { return f !== fn; }); };
        },
    };
    ["syncNow", "downloadNow", "setConfig", "join", "create", "leave", "refreshWatches"].forEach(function (m) {
        ctl[m] = function () { return b.call(m, Array.prototype.slice.call(arguments)); };
    });

    window.overwolf = {
        windows: {
            getMainWindow: function () { return { alens: ctl, alensQuit: function () { b.window("quit"); } }; },
            getCurrentWindow: function (cb) { cb({ success: true, window: { id: 1 } }); },
            dragMove: function () { /* the title bar is a CSS drag region here */ },
            minimize: function (id, cb) { b.window("minimize"); if (cb) cb({ success: true }); },
            close: function (id, cb) { b.window("close"); if (cb) cb({ success: true }); },
        },
        utils: {
            openFolderPicker: function (initial, cb) {
                b.browse(initial).then(function (p) { cb(p ? { success: true, path: p } : { success: false }); });
            },
            placeOnClipboard: function (text) { b.copy(text); },
        },
    };
    document.documentElement.classList.add("desktop");
})();
