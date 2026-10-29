// ─────────────────────────────────────────────────────────────────────────────
// Host shim: SillyTavern's API, answered by Lumiverse.
//
// In the SillyTavern build this file re-exports SillyTavern's own modules, and
// its rule is that nothing else under src/ touches SillyTavern directly. That
// rule is what makes this port possible: the suite names about thirty host
// functions, all of them arrive through here, and so replacing this one file
// moves the whole suite to Lumiverse. The rest of src/ is the SillyTavern code.
//
// Same export names, same shapes. Where Lumiverse works differently, the
// difference is absorbed here:
//
//   extension_settings / chat_metadata — SillyTavern hands the browser live
//     objects. Lumiverse keeps both in backend storage, so they are loaded once
//     into LOCAL MIRRORS that the code reads and mutates synchronously, and
//     saveSettingsDebounced() / saveMetadata() flush them back.
//
//   getContext().chat — SillyTavern's live message array. The mirror is
//     refreshed from the backend on the chat events that can change it, and
//     edits the code makes to a message's `mes` are written back by saveChat().
//     The array and its message objects are updated IN PLACE, never replaced,
//     because the suite holds references to messages across awaits the way it
//     can in SillyTavern.
//
//   generateQuietPrompt — the suite's background jobs park a request and send a
//     marker prompt; SillyTavern's prompt event then lets the suite swap the
//     marker for the job's messages. Here the swap happens before sending: the
//     same injection code builds the messages locally and the backend sends them
//     with spindle.generate.quiet.
//
//   Connection profiles — Chomusuke sends its jobs to a second connection with
//     ConnectionManagerRequestService.sendRequest. Lumiverse connections are
//     listed into extension_settings.connectionManager, and sendRequest goes out
//     through the backend with the connection id.
// ─────────────────────────────────────────────────────────────────────────────

import { call, notify } from "./lumi/bridge.js";
import { $ } from "./lumi/globals.js";
import { extensionName } from "./core/constants.js";

// The Spindle frontend context, captured once in setup().
let hostCtx = null;
export function setHostContext(next) { hostCtx = next; }
export function getHostContext() { return hostCtx; }

// -------------------------------------------------------------
// Settings
// -------------------------------------------------------------

export const extension_settings = {
    // Filled from the user's Lumiverse connections by refreshConnections().
    // Read by engine/tasks.js and the Chomusuke tab exactly as SillyTavern's
    // Connection Manager settings are read there.
    connectionManager: { profiles: [], selectedProfile: "" },
};

let settingsFlushTimer = null;

// Sent as a request, not a notification, so a failed write is reported rather
// than the window showing "Saved" over settings that are gone on reload.
export function saveSettingsDebounced() {
    clearTimeout(settingsFlushTimer);
    settingsFlushTimer = setTimeout(flushSettings, 400);
}

export function flushSettings() {
    clearTimeout(settingsFlushTimer);
    return call("settings:save", { settings: extension_settings[extensionName] || {} })
        .catch((e) => {
            console.error("[Megumin Suite] Settings were NOT saved:", e);
            notify("toast", { level: "error", message: "Settings could not be saved. See the browser console.", title: "Megumin Suite" });
        });
}

// -------------------------------------------------------------
// Chat metadata
// -------------------------------------------------------------

export let chat_metadata = {};
let metadataChatId = null;
let metadataFlushTimer = null;

// Writes under the chat the metadata was LOADED for, not whichever chat is open
// by the time the write goes out. A save debounced in one chat and flushed
// after a switch would otherwise land the old chat's NPC bank in the new one.
export function saveMetadata() {
    clearTimeout(metadataFlushTimer);
    metadataFlushTimer = null;
    if (!metadataChatId) return Promise.resolve();
    return call("metadata:save", { chatId: metadataChatId, metadata: chat_metadata })
        .catch((e) => {
            console.error("[Megumin Suite] Chat data was NOT saved:", e);
            notify("toast", { level: "error", message: "Story data could not be saved. See the browser console.", title: "Megumin Suite" });
        });
}

export function saveMetadataDebounced() {
    clearTimeout(metadataFlushTimer);
    const chatAtCall = metadataChatId;
    metadataFlushTimer = setTimeout(() => { if (chatAtCall === metadataChatId) saveMetadata(); }, 1000);
}

async function loadMetadataFor(chatId) {
    // A pending write for the chat being left goes out first.
    if (metadataFlushTimer && metadataChatId && metadataChatId !== chatId) await saveMetadata();
    metadataChatId = chatId || null;
    chat_metadata = chatId ? ((await call("metadata:load", { chatId })) || {}) : {};
    return chat_metadata;
}

// -------------------------------------------------------------
// Chat context mirror
// -------------------------------------------------------------

const mirror = {
    chat: [],
    chatId: null,
    characterId: null,
    characters: [],
    userName: "You",
    persona: "",
    isGenerating: false,
};

// What each message's text was when it last came from (or went to) the server,
// by message id. saveChat() writes back exactly the messages that differ.
const syncedText = new Map();

export const online_status = "connected";
export let name1 = "You";

const connectionManagerRequestService = {
    // SillyTavern's shape: (profileId, messages, maxTokens, options) -> { content }.
    // maxTokens is left to the connection's own preset in Lumiverse.
    async sendRequest(profileId, messages, _maxTokens, options = {}) {
        const signal = options && options.signal;
        if (signal && signal.aborted) throw new DOMException("Request aborted.", "AbortError");
        const job = call("generate:quiet", { messages, connectionId: profileId || null, think: backgroundThinking() }, { timeoutMs: 600000 });
        if (!signal) return job;
        return await Promise.race([
            job,
            new Promise((_, reject) => signal.addEventListener("abort",
                () => reject(new DOMException("Request aborted.", "AbortError")), { once: true })),
        ]);
    },
};

export function getContext() {
    const character = mirror.characters[mirror.characterId] || null;
    return {
        chat: mirror.chat,
        chatId: mirror.chatId,
        characterId: mirror.characterId,
        characters: mirror.characters,
        groupId: null,
        groups: [],
        name1: mirror.userName,
        name2: character ? character.name : "",
        chatMetadata: chat_metadata,
        maxContext: 8192,
        chatCompletionSettings: {},
        onlineStatus: online_status,
        ConnectionManagerRequestService: connectionManagerRequestService,
        stopGeneration: () => { notify("generate:stop", {}); return true; },
        updateMessageBlock,
        Popup,
        POPUP_TYPE,
    };
}

// Lumiverse message -> SillyTavern's { name, mes, is_user, is_system }.
function applyServerMessage(target, m, names) {
    const isUser = m.role === "user" || m.is_user === true;
    const text = typeof m.content === "string" ? m.content : (m.mes || "");
    target.id = m.id;
    target.name = m.name || (isUser ? names.user : names.char);
    target.mes = text;
    target.is_user = isUser;
    target.is_system = m.role === "system" || m.is_system === true;
    target.swipe_id = m.swipe_id;
    target.swipes = m.swipes;
    target.send_date = m.send_date ?? m.created_at ?? target.send_date;
    target.extra = m.extra || {};
    syncedText.set(m.id, text);
    return target;
}

// Reload the mirror from the backend. The array and the message objects already
// in it are kept and updated in place, matched by id.
export async function refreshContext() {
    const data = (await call("context:load")) || {};
    const chatChanged = (data.chatId || null) !== mirror.chatId;

    mirror.chatId = data.chatId || null;
    mirror.characterId = data.character ? 0 : null;
    mirror.characters.length = 0;
    if (data.character) mirror.characters.push(data.character);
    mirror.userName = data.userName || "You";
    mirror.persona = data.persona || "";
    name1 = mirror.userName;

    const names = { user: mirror.userName, char: data.character ? data.character.name : "Character" };
    const byId = new Map(chatChanged ? [] : mirror.chat.map((m) => [m.id, m]));
    if (chatChanged) syncedText.clear();
    const next = (data.messages || []).map((m) => applyServerMessage(byId.get(m.id) || {}, m, names));
    mirror.chat.splice(0, mirror.chat.length, ...next);

    if (chatChanged || metadataChatId !== mirror.chatId) await loadMetadataFor(mirror.chatId);
    return mirror;
}

// The user went back to the home screen.
export async function clearChatContext() {
    mirror.chat.splice(0, mirror.chat.length);
    mirror.chatId = null;
    mirror.characterId = null;
    mirror.characters.length = 0;
    syncedText.clear();
    await loadMetadataFor(null);
}

export function setGenerating(on) { mirror.isGenerating = Boolean(on); }

// The text a message had when it last came from or went to the server. A
// MESSAGE_EDITED event carrying exactly this is the echo of the suite's own
// write, which SillyTavern never reports as an edit.
export function syncedTextOf(messageId) { return syncedText.get(messageId); }
export function isGenerating() { return mirror.isGenerating === true; }

// The character and persona fields SillyTavern's macros read.
export function hostCharacter() { return mirror.characters[mirror.characterId] || null; }
export function hostPersona() { return mirror.persona; }

// -------------------------------------------------------------
// Writing messages back
// -------------------------------------------------------------

async function pushMessage(message) {
    if (!message || !message.id) return;
    const text = String(message.mes ?? "");
    if (syncedText.get(message.id) === text) return;
    syncedText.set(message.id, text);
    try {
        await call("chat:updateMessage", { chatId: mirror.chatId, messageId: message.id, content: text });
    } catch (e) {
        syncedText.delete(message.id);
        console.error("[Megumin Suite] A message edit was NOT saved:", e);
    }
}

// Every message whose text the suite changed since it was loaded.
export async function saveChat() {
    const pending = mirror.chat.filter((m) => m && m.id && syncedText.get(m.id) !== String(m.mes ?? ""));
    for (const m of pending) await pushMessage(m);
}

let chatFlushTimer = null;
export function saveChatDebounced() {
    clearTimeout(chatFlushTimer);
    chatFlushTimer = setTimeout(saveChat, 500);
}

// SillyTavern redraws the bubble from the message; Lumiverse redraws it when
// the stored message changes, so writing it back is the redraw.
export function updateMessageBlock(_messageId, message) {
    pushMessage(message);
}

const imgTag = (m) => `<img src="${m.url}" alt="KazumaInline" title="${String(m.title || "").replace(/"/g, "&quot;")}" style="max-width:100%;border-radius:8px;display:block;" />`;

// A new message. The suite only ever adds image-only messages this way.
export async function addOneMessage(message) {
    if (!mirror.chatId || !message) return null;
    const media = (message.extra && message.extra.media) || [];
    const content = [message.mes || "", ...media.map(imgTag)].filter(Boolean).join("\n\n");
    const res = await call("chat:appendMessage", { chatId: mirror.chatId, message: { role: "assistant", content } });
    await refreshContext();
    return res;
}

export function reloadCurrentChat() { return refreshContext(); }

// SillyTavern draws extra.media as a gallery under the message. Lumiverse has no
// such gallery, so the newest image is written into the message text instead.
export async function appendMediaToMessage(message) {
    const media = message && message.extra && message.extra.media;
    if (!media || !media.length) return;
    const last = media[media.length - 1];
    if (String(message.mes || "").includes(last.url)) return;
    message.mes = `${message.mes || ""}\n\n${imgTag(last)}`;
    await pushMessage(message);
}

// -------------------------------------------------------------
// Generation
// -------------------------------------------------------------

// While a Chomusuke job runs on its own profile, engine/tasks.js points every
// quiet prompt here at it. Null the rest of the time.
let quietRoute = null;
export function setQuietRoute(fn) { quietRoute = fn; }

// The prompt builder, handed over by frontend.js. Not imported here because
// engine/injection.js imports this file.
let promptBuilder = null;
export function setPromptBuilder(fn) { promptBuilder = fn; }

const MARKER = /^___PS_[A-Z0-9_]+___$/;

// Builds the messages a quiet prompt stands for: a job marker becomes the job's
// own prompt, anything else goes as one user message.
export async function buildQuietMessages(text) {
    const t = String(text || "").trim();
    if (MARKER.test(t)) {
        const messages = [];
        if (promptBuilder) await promptBuilder({ chat: messages, dryRun: false }, "quiet");
        return messages;
    }
    return t ? [{ role: "user", content: t }] : [];
}

export async function generateQuietPrompt(params = {}) {
    const text = typeof params === "string" ? params : (params.quietPrompt ?? params.prompt ?? "");
    if (quietRoute) return await quietRoute(text);
    const messages = await buildQuietMessages(text);
    // A prompt cancelled in the preview popup sends nothing.
    if (!messages.length) return "";
    const connectionId = await selectedConnectionId();
    const res = await call("generate:quiet", { messages, connectionId, think: backgroundThinking() }, { timeoutMs: 600000 });
    return (res && typeof res.content === "string") ? res.content : "";
}

// Settings -> "Let background jobs think". Off unless turned on.
function backgroundThinking() {
    return extension_settings[extensionName]?.globalSettings?.bgThinking === true;
}

// The connection picked in Lumiverse's own connection selector: the one the
// story is on, and the one SillyTavern's quiet prompt would use. Read fresh,
// because the user can switch it at any time.
async function selectedConnectionId() {
    try {
        const r = await fetch("/api/v1/settings/activeProfileId", { credentials: "include" });
        if (!r.ok) return null;
        const j = await r.json();
        return (j && typeof j.value === "string" && j.value) || null;
    } catch (e) {
        return null;
    }
}

// -------------------------------------------------------------
// Macros
// -------------------------------------------------------------
//
// Synchronous, because the prompt builder calls it in the middle of a string
// replacement loop. Lumiverse's own macro engine has already run over the
// prompt by the time the suite sees it, so this only has to resolve the macros
// in the suite's OWN text: names, and the card and persona fields.

export function substituteParams(text) {
    if (text === undefined || text === null) return text;
    const ch = hostCharacter() || {};
    const values = {
        user: mirror.userName || "You",
        char: ch.name || "the character",
        description: ch.description || "",
        personality: ch.personality || "",
        scenario: ch.scenario || "",
        persona: mirror.persona || "",
        mesexamples: ch.mes_example || "",
    };
    return String(text).replace(/\{\{(user|char|description|personality|scenario|persona|mesExamples)\}\}/gi,
        (_, name) => values[name.toLowerCase()] ?? "");
}

// -------------------------------------------------------------
// Lorebooks
// -------------------------------------------------------------
//
// SillyTavern lets the suite ask which World Info entries the recent chat would
// activate. Lumiverse decides that during prompt assembly, and the backend
// remembers what the last real generation activated. checkWorldInfo hands that
// back in SillyTavern's shape; getSortedEntries lists the entries of the books
// attached to the chat's character and persona.

export async function checkWorldInfo() {
    const res = (await call("lore:active", { chatId: mirror.chatId }).catch(() => null)) || {};
    return { worldInfoBefore: (res.entries || []).join("\n\n"), worldInfoAfter: "" };
}

export async function getSortedEntries() {
    return (await call("lore:entries", { chatId: mirror.chatId }).catch(() => null)) || [];
}

// -------------------------------------------------------------
// Events
// -------------------------------------------------------------
//
// frontend.js translates Lumiverse's events into SillyTavern's and emits them
// here, with SillyTavern's arguments (message INDEX rather than id). So the
// suite's listeners keep the signatures they were written with.

export const event_types = {
    APP_READY: "app_ready",
    CHAT_CHANGED: "chat_id_changed",
    MESSAGE_SENT: "message_sent",
    MESSAGE_RECEIVED: "message_received",
    MESSAGE_EDITED: "message_edited",
    MESSAGE_DELETED: "message_deleted",
    MESSAGE_SWIPED: "message_swiped",
    MESSAGE_SWIPE_DELETED: "message_swipe_deleted",
    MESSAGE_UPDATED: "message_updated",
    CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
    USER_MESSAGE_RENDERED: "user_message_rendered",
    GENERATION_STARTED: "generation_started",
    GENERATION_ENDED: "generation_ended",
    GENERATION_STOPPED: "generation_stopped",
    MORE_MESSAGES_LOADED: "more_messages_loaded",
    IMAGE_SWIPED: "image_swiped",
    CHAT_COMPLETION_PROMPT_READY: "chat_completion_prompt_ready",
    CONNECTION_PROFILE_LOADED: "connection_profile_loaded",
};

const listeners = new Map();

export const eventSource = {
    on(name, fn) {
        if (!name || typeof fn !== "function") return;
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
    },
    once(name, fn) {
        const wrapped = (...args) => { eventSource.removeListener(name, wrapped); return fn(...args); };
        eventSource.on(name, wrapped);
    },
    removeListener(name, fn) {
        const list = listeners.get(name);
        if (list) listeners.set(name, list.filter((f) => f !== fn));
    },
    // Awaits every listener in turn, as SillyTavern's emit does. One that throws
    // is logged and the rest still run.
    async emit(name, ...args) {
        for (const fn of [...(listeners.get(name) || [])]) {
            try { await fn(...args); }
            catch (e) { console.error(`[Megumin Suite] "${name}" listener failed:`, e); }
        }
    },
};

// -------------------------------------------------------------
// Popup
// -------------------------------------------------------------

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3 };

// SillyTavern's Popup is new Popup(content, type, inputValue, opts) and then
// await popup.show(), resolving to the input string, true/false, or null.
// Rebuilt on Spindle's modal so the call sites keep that shape. Content may be a
// string, a DOM node or a jQuery object; all three are used.
export class Popup {
    constructor(content, type = POPUP_TYPE.TEXT, inputValue = "", options = {}) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = options || {};
        this.dlg = null;
    }

    #node() {
        const content = this.content;
        if (content == null) return null;
        if (typeof content === "object" && content.jquery) {
            const fragment = document.createDocumentFragment();
            for (const el of Array.from(content)) fragment.appendChild(el);
            return fragment;
        }
        if (content instanceof Node) return content;
        const wrapper = document.createElement("div");
        wrapper.innerHTML = String(content);
        return wrapper;
    }

    async show() {
        if (!hostCtx) return null;
        const node = this.#node();
        // SillyTavern's third argument is the INPUT default for an input popup;
        // the other call sites pass their heading there.
        const title = this.options.title
            || (this.type !== POPUP_TYPE.INPUT && typeof this.inputValue === "string" ? this.inputValue : "")
            || "";

        return new Promise((resolve) => {
            const modal = hostCtx.ui.showModal({
                title,
                width: this.options.wide ? 900 : 560,
                maxHeight: this.options.large ? 820 : 640,
            });
            modal.root.classList.add("megumin-popup");

            const body = document.createElement("div");
            body.className = "megumin-popup-body";
            if (node) body.appendChild(node);
            modal.root.appendChild(body);
            this.dlg = modal.root;

            let input = null;
            if (this.type === POPUP_TYPE.INPUT) {
                input = document.createElement(this.options.rows > 1 ? "textarea" : "input");
                input.className = "megumin-popup-input ps-modern-input";
                input.value = this.inputValue || "";
                modal.root.appendChild(input);
                setTimeout(() => input.focus(), 50);
            }

            const actions = document.createElement("div");
            actions.className = "megumin-popup-actions";

            let settled = false;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
                modal.dismiss();
            };

            const ok = document.createElement("button");
            ok.type = "button";
            ok.className = "megumin-popup-ok";
            ok.textContent = this.options.okButton || "OK";
            ok.addEventListener("click", () => {
                // onClosing is a veto: the workflow editor uses it to refuse
                // invalid JSON.
                if (typeof this.options.onClosing === "function") {
                    let allowed = true;
                    try { allowed = this.options.onClosing(this) !== false; } catch (e) { allowed = false; }
                    if (!allowed) return;
                }
                settle(input ? input.value : true);
            });
            actions.appendChild(ok);

            if (this.type !== POPUP_TYPE.TEXT || this.options.cancelButton) {
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.className = "megumin-popup-cancel";
                cancel.textContent = typeof this.options.cancelButton === "string" ? this.options.cancelButton : "Cancel";
                cancel.addEventListener("click", () => settle(this.type === POPUP_TYPE.CONFIRM ? false : null));
                actions.appendChild(cancel);
            }

            modal.root.appendChild(actions);
            modal.onDismiss(() => settle(this.type === POPUP_TYPE.CONFIRM ? false : null));
        });
    }
}

// -------------------------------------------------------------
// Small utilities SillyTavern owns
// -------------------------------------------------------------

export function debounce(fn, timeout = 300) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), timeout);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

export function cancelDebounce(debounced) {
    if (debounced && typeof debounced.cancel === "function") debounced.cancel();
}

export async function waitUntilCondition(condition, timeout = 1000, interval = 100, { rejectOnTimeout = true } = {}) {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) {
            if (rejectOnTimeout) throw new Error("Timed out waiting for condition");
            return;
        }
        await new Promise((r) => setTimeout(r, interval));
    }
}

export function humanizedDateTime() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        + `@${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
}

// SillyTavern wrote the file to disk and returned a path; Lumiverse stores it in
// its image library and returns the URL. Callers only point an <img> at it.
export function saveBase64AsFile(base64, _folder, filename, extension) {
    return call("media:saveBase64", { chatId: mirror.chatId, base64, filename, extension });
}

export function getRequestHeaders() {
    return { "Content-Type": "application/json" };
}

// -------------------------------------------------------------
// Startup
// -------------------------------------------------------------

export async function hydrate() {
    extension_settings[extensionName] = (await call("settings:load")) || {};
    await refreshConnections();
}

// The user's Lumiverse connections, in the shape SillyTavern's Connection
// Manager keeps its profiles. `mode` is always chat completion: Lumiverse has
// no text-completion connections for the suite to refuse.
export async function refreshConnections() {
    try {
        const res = (await call("connections:list")) || {};
        const cm = extension_settings.connectionManager;
        cm.profiles = (res.connections || []).map((c) => ({ id: c.id, name: c.name, mode: "cc", model: c.model, provider: c.provider }));
        cm.selectedProfile = (await selectedConnectionId()) || res.activeId || "";
    } catch (e) {
        console.warn("[Megumin Suite] Could not list connections:", e);
    }
}

export { $ };
