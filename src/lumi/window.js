// ─────────────────────────────────────────────────────────────────────────────
// The settings window and the launcher button that opens it.
//
// In SillyTavern, index.js appends example.html to the page: a fixed button and
// a full-screen overlay holding the window. A Spindle extension has no HTML file
// the host loads for it, so the same markup is built here:
//
//   the overlay  ->  an app mount at the end of <body>, given the overlay's id
//                    so style.css (including its phone layout) applies as is.
//                    The end of <body> rather than the host's "app-overlay"
//                    layer, because the app shell applies containment and a
//                    position: fixed child would anchor to the shell instead of
//                    the viewport.
//   the button   ->  a host float widget, which drags, snaps to an edge and
//                    remembers where it was left, all natively.
// ─────────────────────────────────────────────────────────────────────────────

import { watchIcons, LAUNCHER_ICON_SVG } from "./icon.js";

const WINDOW_HTML = `
<div class="ps-modern-modal app-container">

    <!-- The Floating Glass Dock -->
    <div class="dock" id="ps_dynamic_dots"></div>

    <div class="main-wrapper">
        <!-- The Full-Width Hero Banner -->
        <div class="hero-banner" id="ps_hero_banner">
            <div class="hero-overlay"></div>

            <div class="top-app-bar">
                <div class="app-actions">
                    <div id="ps_live_token_count" title="Estimated Payload Tokens" style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); background: rgba(0,0,0,0.5); padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-color); backdrop-filter: blur(4px); transition: color 0.3s ease; margin-right: 10px; display: flex; align-items: center; gap: 6px; cursor: default;">
                        <i class="fa-solid fa-microchip"></i> ~0
                    </div>
                    <button id="ps_btn_power" class="ps-modern-btn secondary" title="Turn the whole suite on or off." style="color: #10b981; border-color: rgba(16,185,129,0.3);"><i class="fa-solid fa-power-off"></i> On</button>
                    <button id="btn_apply_tab_all" class="ps-modern-btn secondary" title="When on, every change on this tab is applied to all characters and groups." style="color: var(--gold); border-color: rgba(245,158,11,0.3);"><i class="fa-solid fa-earth-americas"></i> Global: Off</button>
                    <button id="ps_btn_reset" class="ps-modern-btn secondary" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.3);"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                    <button id="ps_btn_dev_mode" class="ps-modern-btn secondary" style="color: #a855f7; border-color: rgba(168, 85, 247, 0.3);"><i class="fa-solid fa-code"></i> Dev</button>
                    <div id="ps_save_indicator" style="display: none; color: #10b981; font-weight: bold; font-size: 0.85rem;"><i class="fa-solid fa-check"></i> Saved</div>
                    <button id="ps_btn_save_close" class="ps-modern-btn primary" style="background: #10b981; color: #fff;"><i class="fa-solid fa-floppy-disk"></i> Save &amp; Close</button>
                    <button id="ps_btn_close" class="ps-modern-btn secondary" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>

            <div class="hero-content">
                <div class="status" id="ps_rule_status_main">Global Default</div>
                <h2 class="name" id="ps_char_rule_label">Lumiverse Profile</h2>
            </div>
        </div>

        <!-- Main Content Area -->
        <div class="main-content" id="ps_stage_content"></div>
    </div>

</div>
`;

let appMount = null;
let windowOpen = false;

export function buildSettingsWindow(mount) {
    appMount = mount;
    mount.root.id = "prompt-slot-modal-overlay";
    mount.root.classList.add("megumin-suite-app");
    mount.root.innerHTML = WINDOW_HTML;
    // Tabs redraw themselves in place on nearly every click, and the fresh
    // markup arrives as bare <i class="fa-..."> tags. See icon.js.
    watchIcons(mount.root);
    closeSettingsWindow();
    return mount.root;
}

export function openSettingsWindow() {
    if (!appMount) return;
    windowOpen = true;
    appMount.setVisible(true);
    appMount.root.classList.add("megumin-open");
}

export function closeSettingsWindow() {
    if (!appMount) return;
    windowOpen = false;
    appMount.root.classList.remove("megumin-open");
    appMount.setVisible(false);
}

export function isSettingsWindowOpen() {
    return windowOpen;
}

// -------------------------------------------------------------
// Launcher
// -------------------------------------------------------------

export function buildLauncher(widget, onOpen) {
    widget.root.classList.add("meg-float");
    widget.root.innerHTML =
        `<button id="prompt-slot-fixed-btn" class="meg-float-btn" type="button" title="Megumin Suite" aria-label="Megumin Suite">`
        + LAUNCHER_ICON_SVG
        + `</button>`;
    bindLauncher(widget.root.querySelector("button"), onOpen);
}

// The widget is dragged by its contents, so the pointerup that ends a drag also
// lands on the button as a click. Pointer travel tells "moved it" from "pressed
// it"; past a few pixels it was a drag and the click is swallowed.
function bindLauncher(button, onOpen) {
    if (!button) return;
    const THRESHOLD_PX = 6;
    let start = null;
    let dragged = false;

    button.addEventListener("pointerdown", (event) => {
        start = { x: event.clientX, y: event.clientY };
        dragged = false;
    });
    button.addEventListener("pointerup", (event) => {
        if (!start) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > THRESHOLD_PX) dragged = true;
        start = null;
    });
    button.addEventListener("pointercancel", () => {
        start = null;
        dragged = true;
    });
    button.addEventListener("click", (event) => {
        if (dragged) {
            dragged = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        onOpen();
    }, true);
}
