// ────────────────────────────────────────────────────────────────────────────
// NPC portrait generation on the Lumiverse image connection.
//
// Refreshes the list through the hook rather than calling renderNpcList()
// directly. That single call was the only thing making this file and the tab
// depend on each other; routing it through the registry leaves the dependency
// pointing one way, and the hook already existed for the profile loader.
// ────────────────────────────────────────────────────────────────────────────

import { getContext, generateQuietPrompt, getRequestHeaders, Popup, POPUP_TYPE } from "../../st.js";
import { localProfile } from "../../core/state.js";
import { meguminActiveDataIdentity } from "../../core/keys.js";
import { saveProfileToMemory } from "../../core/profile.js";
import { fireRefreshHook, REFRESH } from "../../core/refreshHooks.js";
import { setActiveNpcPfpRequest } from "../../core/activeRequests.js";
import { showKazumaProgress } from "../../ui/progress.js";
import { npcBuildTextFromData } from "./data.js";
import { call } from "../../lumi/bridge.js";
import { imageSource } from "../imagegen/comfy.js";
import { comfyFetch } from "../imagegen/comfyFetch.js";

// Generate NPC portrait via ComfyUI — uses AI to generate the prompt from full NPC info

export async function npcGeneratePfp(npcName) {
    const s = localProfile.imageGen;
    if (!s || !s.enabled) {
        toastr.warning("Turn on Images in the Images tab first.");
        return null;
    }

    const npc = localProfile.npcBank.npcs.find(n => n.name === npcName);
    if (!npc) return null;

    // `npc` is a live object inside the profile that is loaded right now, and it is held
    // across a prompt generation, a confirm popup the user may sit on for minutes, and a
    // ComfyUI render polled once a second. Stamp the chat it belongs to here so the write
    // at the end can tell whether it is still the right one.
    const pfpIdentity = meguminActiveDataIdentity();

    // Build full NPC dossier text for the AI
    const npcText = npcBuildTextFromData(npc);

    let styleStr = s.promptStyle === "illustrious" ? "Use Danbooru-style tags separated by commas. Focus on anime art style." : (s.promptStyle === "sdxl" ? "Use natural, descriptive prose and full sentences. Focus on photorealism." : "Use a comma-separated list of detailed keywords and visual descriptors.");
    let perspStr = "This is a CHARACTER PORTRAIT. Frame it as an upper-body/bust shot focused on the character's face and shoulders. Soft, flattering lighting. Clean or simple background. Capture their personality through expression and posture.";

    toastr.info(`Generating portrait prompt for ${npcName}...`, "NPC Bank");
    showKazumaProgress("AI is writing portrait prompt...");

    // Step 1: Ask the AI to generate an image prompt from the NPC dossier
    setActiveNpcPfpRequest({ npcName, npcText, styleStr, perspStr, extraStr: s.promptExtra || "None" });

    let promptText;
    try {
        let rawOutput = await generateQuietPrompt({ prompt: "___PS_NPC_PFP___" });
        promptText = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

        // Try to extract <img prompt="..."> if the AI wrapped it
        const imgRegex = /<img[^>]*?prompt=(["']?)([\s\S]*?)(?:\1\s*\/?>|\1\s*>|\1\s+[a-zA-Z]+=| \/>|>|$)/i;
        const match = promptText.match(imgRegex);
        if (match) promptText = match[2];
    } catch (e) {
        console.error("NPC PFP prompt generation failed:", e);
        $("#kazuma_progress_overlay").hide();
        toastr.error("Failed to generate portrait prompt.");
        setActiveNpcPfpRequest(null);
        return null;
    } finally {
        setActiveNpcPfpRequest(null);
    }

    if (!promptText || promptText.length < 5) {
        $("#kazuma_progress_overlay").hide();
        toastr.error("AI returned an empty prompt.");
        return null;
    }

    console.log(`[Megumin-Suite] NPC PFP prompt for ${npcName}: ${promptText}`);
    
    // --- ALWAYS ON PROMPT PREVIEW / EDIT FOR NPC PORTRAITS ---
    $("#kazuma_progress_overlay").hide(); // Hide progress bar temporarily

    const $content = $(`
        <div style="display:flex; flex-direction:column; gap:10px; font-family: 'Inter', sans-serif;">
            <div style="font-size: 0.85rem; color: var(--text-muted);">Review or modify the character portrait prompt before rendering.</div>
            <textarea class="ps-modern-input npc-preview-textarea" style="height: 150px; resize: vertical; font-family: monospace; font-size: 0.85rem; padding: 10px;">${promptText}</textarea>
        </div>
    `);

    // Capture the text dynamically as the user types
    let liveText = promptText;
    $content.find(".npc-preview-textarea").on("input", function () {
        liveText = $(this).val();
    });

    const popup = new Popup($content, POPUP_TYPE.CONFIRM, `Edit Portrait Prompt: ${npcName}`, { okButton: "Render Portrait", cancelButton: "Cancel", wide: true });
    const confirmed = await popup.show();

    if (!confirmed) {
        toastr.info("Portrait generation cancelled.");
        setActiveNpcPfpRequest(null);
        return null;
    }

    promptText = liveText.trim();
    if (!promptText) {
        toastr.warning("Prompt cannot be empty.");
        setActiveNpcPfpRequest(null);
        return null;
    }

    toastr.info("Drawing the portrait...", "NPC Bank");
    showKazumaProgress("Rendering NPC Portrait...");

    // Step 2: draw it on the Lumiverse image connection. The portrait is kept
    // as a data URL on the NPC record (the bank only draws image data URLs), so
    // the image comes back as one.
    let dataUrl = null;
    try {
        dataUrl = imageSource() === "lumi" ? await pfpDrawLumi(promptText, s) : await pfpDrawComfy(promptText, s);
        if (!dataUrl) throw new Error("the image generator returned no image");
    } catch (e) {
        $("#kazuma_progress_overlay").hide();
        toastr.error("Portrait failed: " + ((e && e.message) || e), "NPC Bank");
        return null;
    }

    // Compressed to JPEG: the portrait lives in chat data and is sent with
    // prompts when NPC portraits are on.
    const compressed = await new Promise((r) => {
        const img = new Image(); img.src = dataUrl;
        img.onload = () => { const cvs = document.createElement("canvas"); cvs.width = img.width; cvs.height = img.height; cvs.getContext("2d").drawImage(img, 0, 0); r(cvs.toDataURL("image/jpeg", 0.85)); };
        img.onerror = () => r(dataUrl);
    });

    // A stale `npc` is a detached object from the old profile.
    if (meguminActiveDataIdentity() !== pfpIdentity) {
        console.debug(`[Megumin-Suite] NPC portrait declined: it was generated for "${pfpIdentity}" but "${meguminActiveDataIdentity()}" is active now.`);
        $("#kazuma_progress_overlay").hide();
        return null;
    }
    npc.pfp = compressed;
    saveProfileToMemory();
    $("#kazuma_progress_overlay").hide();
    toastr.success(`Portrait generated for ${npcName}!`);
    fireRefreshHook(REFRESH.NPC_LIST);
    return compressed;
}

// On a Lumiverse image connection. The portrait comes back as a data URL.
async function pfpDrawLumi(promptText, s) {
    const list = (await call("imagegen:connections")) || [];
    const c = (s.lumiConnectionId && list.find(x => x.id === s.lumiConnectionId)) || list.find(x => x.is_default) || list[0] || null;
    const res = await call("imagegen:generate", {
        prompt: promptText,
        negativePrompt: s.customNegative || "",
        connectionId: c ? c.id : null,
        wantDataUrl: true,
    }, { timeoutMs: 600000 });
    return res && res.dataUrl;
}

// On ComfyUI, with the selected workflow (SillyTavern's way). The backend
// stores the finished image and returns its URL; the bytes are then read back
// from that same-origin URL and turned into a data URL for the NPC record.
async function pfpDrawComfy(promptText, s) {
    if (!s.currentWorkflowName) throw new Error("pick a ComfyUI workflow on the Images tab's Generator page");
    const wfRes = await comfyFetch("/api/sd/comfy/workflow", { method: "POST", body: JSON.stringify({ file_name: s.currentWorkflowName }) });
    if (!wfRes.ok) throw new Error(`could not load ${s.currentWorkflowName}`);
    const raw = await wfRes.json();
    const workflow = typeof raw === "string" ? JSON.parse(raw) : raw;
    const seed = Math.floor(Math.random() * 1000000000);
    const values = {
        "%prompt%": promptText, "%negative_prompt%": s.customNegative || "", "%seed%": seed,
        "%sampler%": s.selectedSampler || "euler", "%model%": s.selectedModel || "v1-5-pruned.ckpt",
        "%steps%": parseInt(s.steps) || 20, "%scale%": parseFloat(s.cfg) || 7.0, "%denoise%": parseFloat(s.denoise) || 1.0,
        "%clip_skip%": -Math.abs(parseInt(s.clipSkip)) || -1,
        "%lora1%": s.selectedLora || "None", "%lora2%": s.selectedLora2 || "None", "%lora3%": s.selectedLora3 || "None", "%lora4%": s.selectedLora4 || "None",
        "%lorawt1%": parseFloat(s.selectedLoraWt) || 1.0, "%lorawt2%": parseFloat(s.selectedLoraWt2) || 1.0,
        "%lorawt3%": parseFloat(s.selectedLoraWt3) || 1.0, "%lorawt4%": parseFloat(s.selectedLoraWt4) || 1.0,
        "%width%": 512, "%height%": 512,
    };
    for (const nodeId in workflow) {
        const node = workflow[nodeId];
        if (!node.inputs) continue;
        for (const key in node.inputs) {
            if (Object.prototype.hasOwnProperty.call(values, node.inputs[key])) node.inputs[key] = values[node.inputs[key]];
        }
        if (node.class_type === "KSampler" && typeof node.inputs.seed === "number") node.inputs.seed = seed;
    }

    const base = s.comfyUrl;
    const q = await comfyFetch(`${base}/prompt`, { method: "POST", body: JSON.stringify({ prompt: workflow }) });
    if (!q.ok) throw new Error((await q.json()).error || "ComfyUI refused the workflow");
    const { prompt_id } = await q.json();

    // Poll until ComfyUI lists the outputs, up to 10 minutes.
    for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const hRes = await comfyFetch(`${base}/history/${prompt_id}`);
        if (!hRes.ok) continue;
        const h = await hRes.json();
        if (!h[prompt_id]) continue;
        let img = null;
        for (const nodeId in h[prompt_id].outputs) {
            const out = h[prompt_id].outputs[nodeId];
            if (out.images && out.images.length) { img = out.images[0]; break; }
        }
        if (!img) return null;
        const view = await comfyFetch(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}`);
        if (!view.ok) throw new Error("ComfyUI finished but the image could not be fetched");
        const blob = await view.blob();
        return await new Promise((r) => { const reader = new FileReader(); reader.onloadend = () => r(reader.result); reader.readAsDataURL(blob); });
    }
    throw new Error("ComfyUI did not finish within 10 minutes");
}
