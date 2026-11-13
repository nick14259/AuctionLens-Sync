// The app's background page: always running while the app is, invisible. It owns the
// controller; the main window reads and drives it through window.alens, reached with
// overwolf.windows.getMainWindow().

/* global overwolf */
import { createController } from "./controller.js";
import { makeOverwolfEnv } from "./owenv.js";

const env = makeOverwolfEnv(overwolf, (...a) => window.fetch(...a));
const ctl = createController({ ow: overwolf, env, storage: window.localStorage });
window.alens = ctl;

function showMain() {
    overwolf.windows.obtainDeclaredWindow("main", (r) => {
        if (r && r.success && r.window) overwolf.windows.restore(r.window.id, () => {});
    });
}
window.alensShowMain = showMain;

/** Ends the app: the background page closing takes every window with it. */
window.alensQuit = () => {
    overwolf.windows.getCurrentWindow((r) => {
        if (r && r.success) overwolf.windows.close(r.window.id, () => {});
    });
};

overwolf.games.onGameInfoUpdated.addListener((e) => {
    if (e && (e.runningChanged || e.gameChanged)) ctl.onGameInfo(e.gameInfo);
});

// The dock / launcher icon while already running.
overwolf.extensions.onAppLaunchTriggered.addListener(() => showMain());

ctl.start().then(() => {
    overwolf.games.getRunningGameInfo((gi) => {
        if (gi && gi.isRunning && Math.floor(gi.id / 10) === 765) {
            // Started by the game launching: stay in the background - unless it has
            // never been set up, when the window is the only way forward.
            ctl.onGameInfo(gi);
            if (!ctl.snapshot().joined) showMain();
        } else {
            showMain();
        }
    });
});
