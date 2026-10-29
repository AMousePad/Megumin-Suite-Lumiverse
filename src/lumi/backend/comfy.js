// -----------------------------------------------------------------------------
// Talking to ComfyUI.
//
// The image-generation tab needs two things from ComfyUI's world: direct calls to
// the instance (ping, list checkpoints / samplers / LoRAs, queue a prompt, poll
// history, download the finished image) and a place to keep saved workflow files.
//
// A browser cannot make the direct calls, because ComfyUI sends no CORS headers.
// An extension backend cannot make them with raw network calls either, because
// Lumiverse blocks those in backends. The sanctioned route is spindle.cors(),
// which performs the request from the Lumiverse SERVER on our behalf. That has two
// consequences worth remembering:
//
//   - The address must be reachable from the machine running Lumiverse, not from
//     the browser. "localhost" means the server's own loopback. Private LAN
//     ranges (192.168.x.x, 10.x.x.x, ...) are allowed by the proxy.
//   - The extension needs the "CORS proxy" (cors_proxy) permission, granted by the
//     user in the Extensions panel.
//
// spindle.cors() resolves to { status, statusText, headers, body, encoding? }.
// Header names are lowercase. Text bodies arrive as strings; for binary image
// requests (responseType "arraybuffer" + mediaType "image") the body is a base64
// string and encoding is "base64". Non-2xx statuses are returned, not thrown, so
// each caller checks the status itself.
//
// Saved workflows live in per-user extension storage, because they are ComfyUI
// graphs the user pasted in and each user keeps their own.
// -----------------------------------------------------------------------------

const WORKFLOW_DIR = "workflows/";

// The user types this into a text box, so accept "host:8188" and "host:8188/".
function normalizeBase(baseUrl) {
    let base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("No ComfyUI address is set");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `http://${base}`;
    return base;
}

// spindle.cors rejects with a PERMISSION_DENIED error when the user has not
// granted cors_proxy. The bare message means nothing to them, so say what to do.
async function corsCall(url, init) {
    try {
        return await spindle.cors(url, init);
    } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        if (/PERMISSION_DENIED|cors_proxy/i.test(msg)) {
            throw new Error(
                'Megumin Suite needs the "CORS proxy" (cors_proxy) permission to reach ComfyUI. ' +
                    "Grant it in Lumiverse's Extensions panel, then try again.",
            );
        }
        throw err;
    }
}

// ComfyUI is a machine the user named, which means it can be off, wrong, or slow.
// Every call below is expected to fail routinely and throws a readable message.
async function comfyGet(baseUrl, path) {
    const res = await corsCall(`${normalizeBase(baseUrl)}${path}`, { method: "GET" });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`ComfyUI answered ${res.status} for ${path}`);
    }
    try {
        return JSON.parse(res.body);
    } catch {
        throw new Error(`ComfyUI sent something other than JSON for ${path}`);
    }
}

// Pull the option list out of an /object_info node description. ComfyUI nests it
// as input.required.<field>[0], and which field varies by node, so the caller
// names it.
function optionsFrom(info, nodeName, field) {
    const node = info && info[nodeName];
    const required = node && node.input && node.input.required;
    const entry = required && required[field];
    return Array.isArray(entry) && Array.isArray(entry[0]) ? entry[0] : [];
}

export async function comfyPing(url) {
    await comfyGet(url, "/system_stats");
    return { ok: true };
}

export async function comfyModels(url) {
    const info = await comfyGet(url, "/object_info/CheckpointLoaderSimple");
    return optionsFrom(info, "CheckpointLoaderSimple", "ckpt_name");
}

export async function comfySamplers(url) {
    const info = await comfyGet(url, "/object_info/KSampler");
    return optionsFrom(info, "KSampler", "sampler_name");
}

// The RAW /object_info/LoraLoader response, not an extracted list. The tab's call
// site does its own digging (json['LoraLoader'].input.required.lora_name[0]), so
// returning a tidy array would leave the LoRA slots stuck on "Loading...".
export function comfyLoras(url) {
    return comfyGet(url, "/object_info/LoraLoader");
}

// -- Saved workflows ----------------------------------------------------------

// Names come from the tab, but they become storage paths, so refuse anything that
// could climb out of the workflows directory.
function workflowPath(name) {
    const n = String(name || "");
    if (!n || n.includes("/") || n.includes("\\") || n.includes("..")) {
        throw new Error(`Invalid workflow name: ${n}`);
    }
    if (!n.endsWith(".json")) throw new Error("Workflow names must end in .json");
    return WORKFLOW_DIR + n;
}

export async function listWorkflows(userId) {
    const files = await spindle.userStorage.list(WORKFLOW_DIR, userId).catch(() => []);
    return files
        .map((f) => String(f).replace(WORKFLOW_DIR, ""))
        .filter((f) => f.endsWith(".json"));
}

export function readWorkflow(name, userId) {
    return spindle.userStorage.read(workflowPath(name), userId);
}

export function saveWorkflow(name, workflow, userId) {
    return spindle.userStorage.write(workflowPath(name), workflow, userId);
}

export function deleteWorkflow(name, userId) {
    return spindle.userStorage.delete(workflowPath(name), userId);
}

// -- Running a generation -----------------------------------------------------

export async function queuePrompt(url, workflow, clientId) {
    const res = await corsCall(`${normalizeBase(url)}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (res.status < 200 || res.status >= 300) {
        // ComfyUI puts the reason a graph was rejected in the body, and it is the
        // only useful thing the user can act on - a bare status tells them
        // nothing about which node is wrong.
        throw new Error(
            `ComfyUI rejected the workflow (${res.status}): ${String(res.body || "").slice(0, 400)}`,
        );
    }
    try {
        return JSON.parse(res.body);
    } catch {
        throw new Error("ComfyUI accepted the workflow but sent back unreadable JSON");
    }
}

export function promptHistory(url, promptId) {
    return comfyGet(url, `/history/${encodeURIComponent(promptId)}`);
}

// Download a finished image from ComfyUI and store it in Lumiverse.
//
// Returns { url, id, mime } - a same-origin URL the browser can load - NOT the
// bytes. Sending a multi-megabyte base64 string back over the extension's
// WebSocket made the earlier version hang silently, and the chat needs a
// displayable URL in the end anyway, which is what spindle.images provides.
export async function fetchImage(url, { filename, subfolder = "", type = "output", chatId, characterId, userId }) {
    const params = new URLSearchParams({ filename, subfolder, type });
    const res = await corsCall(`${normalizeBase(url)}/view?${params}`, {
        method: "GET",
        responseType: "arraybuffer",
        mediaType: "image",
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`ComfyUI answered ${res.status} for the finished image`);
    }

    // The host already base64-encodes binary bodies; use it as is. Header names
    // are lowercase, and a content-type may carry parameters after a semicolon.
    const headers = res.headers || {};
    const mime = String(headers["content-type"] || "image/png").split(";")[0].trim() || "image/png";
    const b64 = String(res.body || "");
    if (!b64) throw new Error("ComfyUI returned an empty image");

    const dataUrl = `data:${mime};base64,${b64}`;

    spindle.log.info(
        `[Megumin Suite] downloaded ${filename} from ComfyUI: ~${((b64.length * 3) / 4 / 1024).toFixed(0)}KB`,
    );

    const stored = await spindle.images.uploadFromDataUrl(dataUrl, {
        originalFilename: filename || "megumin.png",
        owner_chat_id: chatId || undefined,
        owner_character_id: characterId || undefined,
        // Required on an operator-scoped install; it goes INSIDE the options
        // object here, not as a trailing argument the way the chats and
        // characters APIs take it.
        userId,
    });

    if (!stored || !stored.url) {
        throw new Error("Lumiverse accepted the image but returned no URL for it");
    }

    spindle.log.info(`[Megumin Suite] stored as ${stored.url}`);
    return { url: stored.url, id: stored.id, mime };
}
