// ────────────────────────────────────────────────────────────────────────────
// Images tab — Generator page (both versions).
//
// Lumiverse: images are drawn by one of the user's Lumiverse image connections,
// so this page picks the connection and sets what the suite adds to every
// prompt. The model, sampler, steps and LoRAs belong to the connection and are
// set in Lumiverse's own Image Generation settings.
//
// #ig_prefix keeps its id: the V2 style switch writes the quality tags into it.
// ────────────────────────────────────────────────────────────────────────────

import { localProfile } from "../../../core/state.js";
import { saveProfileToMemory, saveProfileDebounced } from "../../../core/profile.js";
import { RESOLUTIONS } from "../../../../data/image_data.js";
import { igTestConnection } from "../comfy.js";
import { igListConnections } from "../lumiImages.js";
import { card, field, switchRow, esc } from "../../../ui/controls.js";

/**
 * @param c        the page container
 * @param onTested called after Test, so the tab can update its status chip
 */
export function renderLumiGenerator(c, { onTested }) {
    const s = localProfile.imageGen;

    // ── Connection ──
    const connCard = card("Image connection");
    const $conn = $(`<div class="igx-inline">
        <select id="ig_lumi_conn" class="ps-modern-input"><option value="">Loading…</option></select>
        <button type="button" id="ig_test_btn" class="menu_button igx-btn gold"><i class="fa-solid fa-plug"></i> Test</button>
    </div>`);
    connCard.append(field("Draw with", "One of your Lumiverse image connections. Its model, sampler and steps are set in Lumiverse.", $conn));
    c.append(connCard);

    const fillConnections = async (force) => {
        const list = await igListConnections({ force });
        const sel = c.find("#ig_lumi_conn").empty();
        if (!list.length) {
            sel.append(`<option value="">No image connection: add one in Lumiverse's settings</option>`);
            return;
        }
        sel.append(`<option value="">Your default image connection</option>`);
        list.forEach(x => sel.append(`<option value="${esc(x.id)}">${esc(x.name)}${x.model ? ` · ${esc(x.model)}` : ""}${x.is_default ? " (default)" : ""}</option>`));
        sel.val(list.some(x => x.id === s.lumiConnectionId) ? s.lumiConnectionId : "");
    };
    fillConnections(true);

    c.find("#ig_lumi_conn").on("change", e => { s.lumiConnectionId = $(e.target).val() || ""; saveProfileToMemory(); });
    c.find("#ig_test_btn").on("click", async () => {
        const $b = c.find("#ig_test_btn");
        if ($b.prop("disabled")) return;
        $b.prop("disabled", true);
        try { await fillConnections(true); await igTestConnection(); } finally { $b.prop("disabled", false); }
        if (onTested) onTested();
    });

    // ── Image ──
    const image = card("Image");
    const $size = $(`<div class="igx-size" style="display:${s.lumiSendSize ? "flex" : "none"};">
        <select id="ig_res_preset" class="ps-modern-input"></select>
        <div class="igx-inline">
            <input type="number" id="ig_w" class="ps-modern-input" value="${esc(s.imgWidth)}" title="Width" />
            <span class="igx-x">×</span>
            <input type="number" id="ig_h" class="ps-modern-input" value="${esc(s.imgHeight)}" title="Height" />
        </div>
    </div>`);
    image.append(switchRow({
        label: "Choose the size",
        desc: "Off: the connection's own size. On: every image is asked for at this size.",
        on: Boolean(s.lumiSendSize),
        onChange: on => { s.lumiSendSize = on; saveProfileToMemory(); $size.css("display", on ? "flex" : "none"); }
    }));
    image.append(field("Size", "Pick one, or type width × height", $size));
    image.append(field("Quality tags", "Put at the start of every prompt. Picking a prompt style fills these in.",
        $(`<input type="text" id="ig_prefix" class="ps-modern-input" value="${esc(s.promptPrefix || "")}" placeholder="masterpiece, best quality…" />`)));
    image.append(field("Negative prompt", "What the image should not have (for connections that use one)",
        $(`<input type="text" id="ig_neg" class="ps-modern-input" value="${esc(s.customNegative)}" />`)));
    image.append(field("Seed", "-1 picks a new one every time", $(`<div class="igx-inline igx-narrow">
        <input type="number" id="ig_seed" class="ps-modern-input" value="${esc(s.customSeed)}" />
        <button type="button" id="ig_seed_dice" class="menu_button igx-btn" title="A new seed every time (-1)"><i class="fa-solid fa-dice"></i></button>
    </div>`)));
    c.append(image);

    const resSel = c.find("#ig_res_preset");
    resSel.append(`<option value="">Pick a size…</option>`);
    RESOLUTIONS.forEach((r, idx) => resSel.append(`<option value="${idx}">${esc(r.label)}</option>`));
    resSel.on("change", e => {
        const r = RESOLUTIONS[parseInt($(e.target).val())];
        if (r) { c.find("#ig_w").val(r.w).trigger("input"); c.find("#ig_h").val(r.h).trigger("input"); }
    });
    c.find("#ig_w, #ig_h").on("input", e => { s[e.target.id === "ig_w" ? "imgWidth" : "imgHeight"] = parseInt($(e.target).val()); saveProfileDebounced(); });
    c.find("#ig_seed").on("input", e => { s.customSeed = parseInt($(e.target).val()); saveProfileDebounced(); });
    c.find("#ig_seed_dice").on("click", () => { s.customSeed = -1; c.find("#ig_seed").val(-1); saveProfileToMemory(); });
    c.find("#ig_prefix").on("input", e => { s.promptPrefix = $(e.target).val(); saveProfileDebounced(); });
    c.find("#ig_neg").on("input", e => { s.customNegative = $(e.target).val(); saveProfileDebounced(); });
}
