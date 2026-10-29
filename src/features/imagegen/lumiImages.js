// ────────────────────────────────────────────────────────────────────────────
// Images through a Lumiverse image connection — the alternative to ComfyUI.
//
// The Images tab can draw with ComfyUI directly (comfy.js, the SillyTavern way)
// or with one of the user's Lumiverse image connections (ComfyUI, SwarmUI,
// NovelAI, Gemini…, whatever they set up in Lumiverse). This is the second:
// the connection owns the model, sampler and steps, and the suite adds the
// quality tags, negative prompt, seed and, if asked, the size.
// ────────────────────────────────────────────────────────────────────────────

import { getContext, saveChat, addOneMessage, updateMessageBlock, Popup, POPUP_TYPE } from "../../st.js";
import { kazumaRetrySweep } from "./comfy.js";
import { call } from "../../lumi/bridge.js";
import { localProfile } from "../../core/state.js";
import { showKazumaProgress } from "../../ui/progress.js";
import { meguminScheduleBlocksRefresh } from "../blocks/chat.js";

// -------------------------------------------------------------
// Connections
// -------------------------------------------------------------

let connectionsCache = null;

/** The user's Lumiverse image connections: [{ id, name, provider, model, is_default }]. */
export async function igListConnections({ force = false } = {}) {
    if (connectionsCache && !force) return connectionsCache;
    try { connectionsCache = (await call("imagegen:connections")) || []; }
    catch (e) { connectionsCache = []; }
    return connectionsCache;
}

// The connection the profile picked, or the user's default image connection.
function chosenConnection(list) {
    const id = localProfile?.imageGen?.lumiConnectionId;
    return (id && list.find(c => c.id === id)) || list.find(c => c.is_default) || list[0] || null;
}

const conn = { ok: null, pending: null };

/** What the last check said: true, false, or null (not known yet). */
export function lumiKnownConnection() {
    return conn.ok;
}

/** Quiet check for the Images tab: true when there is an image connection to draw on. */
export function lumiCheckConnection({ force = false } = {}) {
    if (!force) {
        if (conn.pending) return conn.pending;
        if (conn.ok !== null) return Promise.resolve(conn.ok);
    }
    const job = igListConnections({ force: true }).then(list => {
        conn.ok = Boolean(chosenConnection(list));
        conn.pending = null;
        return conn.ok;
    });
    conn.pending = job;
    return job;
}

export async function lumiTestConnection() {
    const ok = await lumiCheckConnection({ force: true });
    if (ok) {
        const c = chosenConnection(connectionsCache || []);
        toastr.success(`Images will be drawn on "${c.name}".`, "Megumin Suite");
    } else {
        toastr.error("There is no image connection in Lumiverse yet. Add one under Image Generation in Lumiverse's settings.", "Megumin Suite");
    }
    return ok;
}

// -------------------------------------------------------------
// Drawing one image
// -------------------------------------------------------------

/**
 * Draws one image on the Lumiverse image connection and puts it where `target`
 * says: inline in a message (in place of its placeholder), on a message, or as
 * a new message. comfy.js hands over here when the Images tab is set to a
 * Lumiverse connection.
 */
export async function igGenerateWithLumi(positivePrompt, target = null, promptResolver = p => p) {
    const s = localProfile.imageGen;
    let finalPrompt = await promptResolver(positivePrompt);

    // The message being written to must still be in the open chat when the
    // image comes back; the reader can be several chats away by then.
    const igChatId = getContext().chatId ?? null;
    const igResolveTarget = () => {
        const ctx = getContext();
        if ((ctx.chatId ?? null) !== igChatId) return false;
        if (!target || !target.message) return true;
        const chat = ctx.chat;
        if (chat[target.index] === target.message) return true;
        const moved = chat.indexOf(target.message);
        if (moved !== -1) { target.index = moved; return true; }
        if (target.message.id) {
            const byId = chat.findIndex(m => m.id === target.message.id);
            if (byId !== -1) { target.message = chat[byId]; target.index = byId; return true; }
        }
        if (target.placeholderId) {
            const byPh = chat.findIndex(m => typeof m?.mes === "string" && m.mes.includes(target.placeholderId));
            if (byPh !== -1) { target.message = chat[byPh]; target.index = byPh; return true; }
        }
        return false;
    };

    const inline = Boolean(target && target.isInlineAuto && target.mode === "inline");

    // A placeholder left behind by a cancelled or failed render is taken back
    // out, or, for a regenerate, the old image is put back.
    const dropPlaceholder = async () => {
        if (!inline || !target.placeholderId) return;
        if (!igResolveTarget() || !target.message.mes.includes(`id="${target.placeholderId}"`)) return;
        if (target.restoreHtml) {
            target.message.mes = target.message.mes.replace(new RegExp(`<div id="${target.placeholderId}" class="kazuma-img-placeholder"[^>]*>[\\s\\S]*?<\\/div>`), () => target.restoreHtml);
            kazumaRetrySweep(target.index);
        } else {
            target.message.mes = target.message.mes.replace(new RegExp(`\\s*<div id="${target.placeholderId}"[^>]*>[\\s\\S]*?<\\/div>\\s*`), "\n\n").trim();
        }
        await saveChat();
        meguminScheduleBlocksRefresh();
    };

    const writeFailure = async (reason) => {
        if (!inline || !igResolveTarget()) return;
        const wrapperId = target.placeholderId || `kazuma-img-${Date.now()}`;
        const safePrompt = finalPrompt.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const failTag = `<!-- kazuma-inline-start:${wrapperId} --><div id="${wrapperId}" class="kazuma-img-wrapper" style="color:#ef4444; font-style: italic; margin: 10px 0;"><span>[Image Generation Failed${reason ? `: ${String(reason).replace(/</g, "&lt;")}` : ""}]</span> <img alt="KazumaInline" data-kazumaid="${wrapperId}" title="${safePrompt}" style="display:none;" /></div><!-- kazuma-inline-end:${wrapperId} -->`;
        const specific = new RegExp(`<div id="${wrapperId}" class="kazuma-img-placeholder"[^>]*>[\\s\\S]*?<\\/div>`, "g");
        if (specific.test(target.message.mes)) target.message.mes = target.message.mes.replace(specific, failTag);
        else target.message.mes = target.message.mes.replace(/<div class="kazuma-img-placeholder"[^>]*>\[(Generating|Regenerating) Image\.\.\.\]<\/div>/g, failTag);
        kazumaRetrySweep(target.index);
        await saveChat();
        meguminScheduleBlocksRefresh();
    };

    // --- Quality tags at the front ---
    if (s.promptPrefix && s.promptPrefix.trim() !== "") {
        let prefix = s.promptPrefix.trim();
        if (!prefix.endsWith(",")) prefix += ",";
        if (!finalPrompt.startsWith(prefix)) finalPrompt = prefix + " " + finalPrompt;
    }

    // --- Prompt preview ---
    if (s.previewPrompt) {
        $("#kazuma_progress_overlay").hide();
        const $content = $(`
            <div style="display:flex; flex-direction:column; gap:10px; font-family: 'Inter', sans-serif;">
                <div style="font-size: 0.85rem; color: var(--text-muted);">Review or modify the prompt before it is drawn.</div>
                <textarea class="ps-modern-input ig-preview-textarea" style="height: 150px; resize: vertical; font-family: monospace; font-size: 0.85rem; padding: 10px;"></textarea>
            </div>
        `);
        $content.find(".ig-preview-textarea").val(finalPrompt);
        let liveText = finalPrompt;
        $content.find(".ig-preview-textarea").on("input", function () { liveText = $(this).val(); });
        const confirmed = await new Popup($content, POPUP_TYPE.CONFIRM, "Preview Image Prompt", { okButton: "Draw it", cancelButton: "Cancel", wide: true }).show();
        if (!confirmed) { toastr.info("Generation cancelled."); await dropPlaceholder(); return; }
        finalPrompt = String(liveText || "").trim();
        if (!finalPrompt) { toastr.warning("Prompt cannot be empty."); await dropPlaceholder(); return; }
    }

    showKazumaProgress("Drawing the image...");

    // Size and seed go only when the user set them; otherwise the connection's
    // own defaults stand.
    const parameters = {};
    if (s.lumiSendSize) {
        const w = parseInt(s.imgWidth), h = parseInt(s.imgHeight);
        if (w > 0 && h > 0) { parameters.width = w; parameters.height = h; parameters.resolution = `${w}x${h}`; }
    }
    const seed = parseInt(s.customSeed);
    if (Number.isFinite(seed) && seed >= 0) parameters.seed = seed;

    let result;
    try {
        const list = await igListConnections();
        const c = chosenConnection(list);
        result = await call("imagegen:generate", {
            chatId: igChatId,
            prompt: finalPrompt,
            negativePrompt: s.customNegative || "",
            connectionId: c ? c.id : null,
            parameters,
        }, { timeoutMs: 600000 });
    } catch (e) {
        $("#kazuma_progress_overlay").hide();
        toastr.error("Image generation failed: " + ((e && e.message) || e), "Megumin Suite");
        await writeFailure(e && e.message);
        return;
    }

    $("#kazuma_progress_overlay").hide();
    if (!igResolveTarget()) {
        console.debug(`[Megumin-Suite] Image landed after the chat changed; it was not written anywhere.`);
        return;
    }

    const url = result.url;
    const safePrompt = finalPrompt.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const mediaAttach = { url, type: "image", source: "generated", title: finalPrompt, generation_type: "free" };

    if (inline) {
        const wrapperId = target.placeholderId || `kazuma-img-${Date.now()}`;
        const imgTag = `<!-- kazuma-inline-start:${wrapperId} --><div id="${wrapperId}" class="kazuma-img-wrapper">
<img src="${url}" title="${safePrompt}" alt="KazumaInline" data-kazumaid="${wrapperId}" style="max-width: 100%; border-radius: 8px; display: block;" />
</div><!-- kazuma-inline-end:${wrapperId} -->`;
        const specific = new RegExp(`<div id="${target.placeholderId}"[^>]*>[\\s\\S]*?<\\/div>`, "g");
        if (target.placeholderId && target.message.mes.includes(`id="${target.placeholderId}"`)) {
            target.message.mes = target.message.mes.replace(specific, imgTag);
        } else {
            const any = /<div class="kazuma-img-placeholder"[^>]*>\[(Generating|Regenerating) Image\.\.\.\]<\/div>/g;
            if (any.test(target.message.mes)) target.message.mes = target.message.mes.replace(any, imgTag);
            else target.message.mes += `\n\n${imgTag}`;
        }
        kazumaRetrySweep(target.index);
        await saveChat();
        meguminScheduleBlocksRefresh();
        toastr.success("Image injected inline!");
    } else if (target && target.message && !target.isInlineAuto) {
        const wrapperId = `kazuma-img-${Date.now()}`;
        target.message.mes = `${target.message.mes || ""}\n\n<!-- kazuma-inline-start:${wrapperId} --><div id="${wrapperId}" class="kazuma-img-wrapper">
<img src="${url}" title="${safePrompt}" alt="KazumaInline" data-kazumaid="${wrapperId}" style="max-width: 100%; border-radius: 8px; display: block;" />
</div><!-- kazuma-inline-end:${wrapperId} -->`;
        updateMessageBlock(target.index, target.message);
        kazumaRetrySweep(target.index);
        toastr.success("Image added!");
    } else {
        await addOneMessage({ name: "Image Gen Kazuma", is_user: false, is_system: true, send_date: Date.now(), mes: "", extra: { media: [mediaAttach] } });
        toastr.success("Image inserted!");
    }
}

