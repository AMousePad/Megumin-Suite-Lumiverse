// ─────────────────────────────────────────────────────────────────────────────
// The page globals SillyTavern gave every extension for free.
//
// The SillyTavern build writes `$(...)` and `toastr.info(...)` everywhere
// without importing either, because SillyTavern puts jQuery and toastr on
// window. Lumiverse does neither, and putting them on window ourselves would
// mean fighting any other extension that does the same.
//
// So build.mjs adds `import { $, jQuery, toastr } from ".../lumi/globals.js"` to
// every source file that names one of them. The files stay byte-for-byte the
// SillyTavern ones, and the names resolve to these module-scoped values.
//
// This module must import nothing but jQuery and the bridge: it is imported by
// almost every file, so anything it pulled in would be a cycle.
// ─────────────────────────────────────────────────────────────────────────────

import jQueryLib from "jquery";
import { notify } from "./bridge.js";

export const jQuery = jQueryLib;
export const $ = jQueryLib;

// SillyTavern put toastr on window; Lumiverse shows toasts from the backend
// only, so each call is a one-way message. The third argument (toastr's own
// options: timeOut and the like) has no counterpart and is ignored.
function toast(level) {
    return (message, title) => {
        notify("toast", { level, message: String(message ?? ""), title: title ? String(title) : undefined });
    };
}

export const toastr = {
    success: toast("success"),
    info: toast("info"),
    warning: toast("warning"),
    error: toast("error"),
    clear() {},
    remove() {},
};
