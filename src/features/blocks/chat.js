// ────────────────────────────────────────────────────────────────────────────
// Drawing the master block card into chat messages.
//
// The chat side of blocks, kept apart from the Blocks TAB: the tab's preview
// renders through the dict builder, which sits at the top of the dependency
// graph, while this only needs the registry. Splitting there lets image gen
// ask for a redraw without pulling the settings UI in behind it.
// ────────────────────────────────────────────────────────────────────────────

import { getContext, getHostContext } from "../../st.js";
import { extensionName } from "../../core/constants.js";
import { applyBlocksToMessage, clearBlocksFromMessage } from "../../blocks/render.js";
import { meguminRenderRegistry, meguminBlocksTakenByPanel, meguminStatFieldMap } from "./registry.js";
// One directed edge from the blocks feature to the NPC feature. No cycle:
// nothing under features/npc/ imports the block card.
import { npcDecorateUpdatePane } from "../npc/updateCard.js";
import { npcDecorateNewPane } from "../npc/newCard.js";
import { worldCardTextAt, worldExtractMessage, blocksCardTextAt, notebookCardTextAt } from "../../state/index.js";
import { blocksReadForReply } from "./worker.js";
import { bondsDecoratePane, sheetDecoratePane } from "../bonds/overview.js";
import { worldDecoratePane } from "../worldstate/card.js";
import { openWorldEditor } from "../worldstate/editor.js";
import { NOTEBOOK_CARD_DEFS, notebookDecoratePane, notebookCardStamp } from "../notebook/card.js";
import { notebookReadForReply } from "../notebook/worker.js";

// ── Clicking a choice ────────────────────────────────────────────────────────
//
// The card renderer knows nothing about the host — it is handed a callback and
// calls it. Plain click FILLS the input rather than sending: a choice is a
// suggestion, and the reader almost always wants to add to it. Shift sends.
//
// Lumiverse's composer is a React textarea, so the value goes in through the
// native setter followed by an input event, which is what React observes.
function meguminApplyChoice(text, { send = false } = {}) {
    const ta = document.querySelector("textarea[data-chat-input], .chat-input textarea, form textarea, main textarea, textarea");
    if (!ta) return;

    const existing = String(ta.value || "").replace(/\s+$/, "");
    const next = existing ? `${existing} ${text}` : text;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(ta, next);
    else ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (e) { /* not fatal */ }

    if (!send) return;
    // A message leading with a slash is a command to the app, not a line of
    // story; it stays in the box for the reader to decide.
    if (/^\s*\//.test(ta.value)) return;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
}

// ── Playing a roll's arrival animation exactly once ──────────────────────────
//
// The dice reel is the first thing on this card that is not idempotent: drawing
// it twice is visibly different from drawing it once. And the card is rebuilt
// constantly — an edit, a swipe, an image landing, another extension redrawing
// the body; there are a dozen paths in. Left alone, the die would re-roll in
// front of the reader every time any of them fired, which reads as a bug and
// quietly contradicts the one thing the feature promises, that the number is
// fixed once written.
//
// So a roll animates when both are true: it is in the newest message, and it has
// not been played before. Everything else draws the resting state, which is the
// same markup minus one class.
const meguminPlayedRolls = new Set();

// Keyed on the message AND the text of the roll, not on the message alone: a
// swipe replaces the reply at the same index with a different roll, and that one
// has genuinely not been seen yet.
function meguminRollKey(msgIndex, block) {
    return `${msgIndex}:${String(block.body || "").slice(0, 120)}`;
}

// A chat long enough to overflow this has scrolled past every one of these
// messages anyway, so forgetting the oldest costs at most one replay.
function meguminRememberRoll(key) {
    if (meguminPlayedRolls.size > 400) meguminPlayedRolls.clear();
    meguminPlayedRolls.add(key);
}

function meguminIsNewestMessage(msgIndex) {
    try {
        const ctx = typeof getContext === "function" ? getContext() : null;
        return Boolean(ctx && Array.isArray(ctx.chat) && msgIndex === ctx.chat.length - 1);
    } catch (e) {
        // No context means no way to tell, and the safe answer to "should this
        // move" is always no.
        return false;
    }
}

// Returns the predicate the renderer calls, or null when nothing should animate
// — an unknown message index, or any message that is not the newest. Without
// the second half, opening a chat would set every roll in the history spinning
// at once, because every one of them is being drawn for the first time.
function meguminAnimateGate(msgIndex) {
    if (typeof msgIndex !== "number" || !meguminIsNewestMessage(msgIndex)) return null;
    return block => {
        const key = meguminRollKey(msgIndex, block);
        if (meguminPlayedRolls.has(key)) return false;
        meguminRememberRoll(key);
        return true;
    };
}

// One message body, decorated or put back the way SillyTavern drew it.
//
// `msgIndex` is optional and only used to redraw the NPC Update tab from the
// changelog instead of from the model's raw text — see npcDecorateUpdatePane.
// A caller that does not know the index still gets a correct card, just without
// the undo buttons on that one tab.
export function meguminDecorateMessageBody(bodyEl, mesText, msgIndex) {
    try {
        // The world as it stood right after THIS message, drawn from the state
        // store — never from the block text, which may only be a short update.
        const wsText = typeof msgIndex === "number" ? worldCardTextAt(msgIndex) : "";
        // Plan 009: blocks Chomusuke wrote for this message (not in its text).
        const fromWorker = typeof msgIndex === "number" ? blocksCardTextAt(msgIndex) : {};
        const storeBlocks = {};
        Object.entries(fromWorker).forEach(([tag, b]) => {
            storeBlocks[tag] = b.status === "ok" ? b.body
                : b.status === "pending" ? (b.body || "*Writing this block…*")
                : "*Nothing was written for this block. Use Read again.*";
        });
        // Plan 010: notebook lines Chomusuke wrote, on a reply that has no notebook block.
        const nbText = typeof msgIndex === "number" ? notebookCardTextAt(msgIndex) : "";
        if (nbText) storeBlocks.Notebook_Update = nbText;
        // The notebook is not a block in the stack, but its blocks are drawn
        // (behind a spoiler) on every reply that wrote one, on or off.
        applyBlocksToMessage(bodyEl, mesText, [...meguminRenderRegistry(), ...NOTEBOOK_CARD_DEFS], {
            msgIndex,
            detached: true,
            worldStateText: wsText,
            storeBlocks,
            // Drawn from the store, so a Revert changes the card without the text.
            extraStamp: typeof msgIndex === "number" ? notebookCardStamp(msgIndex) : "",
            omit: meguminBlocksTakenByPanel(),
            onChoice: meguminApplyChoice,
            shouldAnimate: meguminAnimateGate(msgIndex),
            statFields: meguminStatFieldMap(),
            debug: Boolean(window.MEGUMIN_BLOCKS_DEBUG)
        });
        if (typeof msgIndex === "number") {
            // The card renderer stays generic — it knows nothing about NPCs. The
            // pane it produced is found by the block id and handed to the NPC
            // feature to fill in.
            const pane = bodyEl.querySelector('.meg-block-body[data-block-id="npcUpdate"]');
            if (pane) npcDecorateUpdatePane(pane, msgIndex);
            // New NPC: one tab per dossier, each with "Open in NPC Bank".
            bodyEl.querySelectorAll('.meg-block-body[data-block-id="newNpc"]').forEach(p => npcDecorateNewPane(p));
            // Same for World State: what this reply changed, on top of the board.
            // Bonds: a button to every character's bonds on file.
            const bondsPane = bodyEl.querySelector('.meg-block-body[data-block-id="bonds"]');
            if (bondsPane) bondsDecoratePane(bondsPane);
            const sheetPane = bodyEl.querySelector('.meg-block-body[data-block-id="sheet"]');
            if (sheetPane) sheetDecoratePane(sheetPane);
            // Blocks Chomusuke wrote: a Read again button on each of their tabs.
            Object.values(fromWorker).forEach(b => {
                const pane = bodyEl.querySelector(`.meg-block-body[data-block-id="${b.id}"]`);
                if (pane) blocksDecorateReadAgain(pane, msgIndex, b.status === "pending");
            });
            bodyEl.querySelectorAll('.meg-block-body[data-block-id="notebook"], .meg-block-body[data-block-id="notebookUpdate"]')
                .forEach(p => notebookDecoratePane(p, msgIndex, {
                    onChanged: () => meguminScheduleBlocksRefresh(),
                    onReread: () => { notebookReadForReply(msgIndex, { force: true }); }
                }));
            const wsPane = bodyEl.querySelector('.meg-block-body[data-block-id="world"]');
            if (wsPane) worldDecoratePane(wsPane, msgIndex, {
                onEdit: () => openWorldEditor(),
                onChanged: () => meguminScheduleBlocksRefresh(),
                onReread: () => { worldExtractMessage(msgIndex, { force: true }); }
            });
        }
    } catch (e) {
        // Fail visible: the reader keeps the raw block text, which is exactly
        // what they had before this existed.
        try { clearBlocksFromMessage(bodyEl); } catch (e2) { /* nothing left to do */ }
        console.debug(`[${extensionName}] block renderer skipped a message`, e);
    }
}

// "Read again" on a tab Chomusuke wrote: it reads the reply once more.
function blocksDecorateReadAgain(pane, msgIndex, pending) {
    if (pane.querySelector(".meg-blocks-reread")) return;
    let tools = pane.querySelector(".meg-bonds-tools");
    if (!tools) {
        tools = document.createElement("div");
        tools.className = "meg-bonds-tools";
        pane.prepend(tools);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "meg-bonds-all meg-blocks-reread";
    b.disabled = pending;
    b.title = "Chomusuke reads this reply again and rewrites its blocks";
    b.innerHTML = pending ? `<i class="fa-solid fa-spinner fa-spin"></i> Writing…` : `<i class="fa-solid fa-rotate"></i> Read again`;
    b.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        blocksReadForReply(msgIndex, { force: true });
    });
    tools.append(b);
}

// ── Attaching cards to Lumiverse's chat ──────────────────────────────────────
//
// SillyTavern renders every message into #chat .mes with a mesid attribute, and
// the card replaced the raw block text inside .mes_text. Lumiverse's chat is
// virtualized, its message markup is the host's own, and its message id is the
// documented handle. So:
//
//   - the block tags are taken out of the rendered text by the HOST, with tag
//     interceptors (removeFromMessage). That works during streaming too: the
//     reader sees a small "processing" mark instead of raw XML scrolling past;
//   - the card goes into a wrapper of our own, injected at the end of the
//     message's content with ctx.dom.inject, which the host re-attaches when a
//     scrolled-away bubble comes back;
//   - the card is built from the raw message text in the chat mirror, matched
//     by message id, so the World State and Chomusuke's blocks (keyed by message
//     INDEX in the state store) are drawn exactly as they are in SillyTavern.

const HIDDEN_TAGS = ["Blocks", "Dice", "Notebook", "Notebook_Update", "Story_Tracker"];
const wrappers = new Map();   // message id -> injected wrapper
const layoutRetries = new Map();
let tagUnsubs = [];
let scrollBound = false;

// Where in a bubble the card goes: after the message text, inside the column
// that holds it, so it sits UNDER the reply at the reply's width. Injecting at
// the bubble root put it beside the text in the bubble's flex row, which on a
// phone squeezed the text column until it showed one letter per line.
function contentTarget(bubble) {
    // Lumiverse's message column: the element holding the prose (and, below
    // it, the long-message viewport). Its class names are CSS-module hashes,
    // so they are matched by their stable prefix.
    // Right after a reply streams in, the column can be missing for a moment;
    // then the bubble itself, never the message ROW around it: the row is a
    // flex line of avatar, bubble and actions, and a card put there sits
    // beside the reply (on a phone it squeezed the text to one letter a line).
    const col = bubble.querySelector("[class^='_content_'], [class*=' _content_']");
    if (col) return col;
    const inner = bubble.querySelector("[class^='_bubble_'], [class*=' _bubble_']");
    return inner || null;
}

// The host wraps whatever is injected in an element of its own (that is what
// it re-attaches on remount); the card goes into our div inside it.
function hostOf(w) {
    return (w && w.querySelector(".meg-blocks-host")) || w;
}

function wrapperFor(ctx, messageId, bubble) {
    const target = contentTarget(bubble);
    if (!target) return null;   // not laid out yet; the next pass draws it
    let w = wrappers.get(messageId);
    // Kept only where it belongs: a wrapper the host replayed into an older
    // layout of the bubble is moved to the column.
    if (w && w.isConnected && w.parentElement === target) return w;
    if (w) { try { ctx.dom.uninject(w); } catch (e) { /* already gone */ } }
    w = ctx.dom.inject(target, '<div class="meg-blocks-host"></div>', "beforeend");
    w.classList.add("meg-blocks-inject");
    wrappers.set(messageId, w);
    return w;
}

// The V11 preset's display regex turns the envelope into
// <details class="meg-blocks-src">, so the reader never sees raw tags even
// without the suite. With a card drawn it is a second copy of the same blocks:
// hidden, the way blocks/render.js hides it in SillyTavern.
const MARKERS = ".meg-blocks-src, .custom-meg-blocks-src";
function setMarkersHidden(bubble, hidden) {
    bubble.querySelectorAll(MARKERS).forEach(el => { el.style.display = hidden ? "none" : ""; });
}

function dropWrapper(ctx, messageId) {
    const w = wrappers.get(messageId);
    if (!w) return;
    try { ctx.dom.uninject(w); } catch (e) { /* already gone */ }
    wrappers.delete(messageId);
}

export function meguminRefreshBlocksInChat() {
    const ctx = getHostContext();
    if (!ctx || !ctx.dom || typeof ctx.dom.listMessageElements !== "function") return;
    const chat = getContext().chat;
    if (!Array.isArray(chat)) return;

    for (const { messageId, element } of ctx.dom.listMessageElements()) {
        const idx = chat.findIndex(m => m && m.id === messageId);
        const msg = chat[idx];
        if (!msg || msg.is_user || msg.is_system) { dropWrapper(ctx, messageId); continue; }
        // A message being edited has the host's textarea in it.
        if (element.querySelector("textarea")) { dropWrapper(ctx, messageId); setMarkersHidden(element, false); continue; }

        const w = wrapperFor(ctx, messageId, element);
        if (!w) {
            // A few retries while the bubble finishes laying out, then it
            // waits for the next event or scroll.
            const n = (layoutRetries.get(messageId) || 0) + 1;
            layoutRetries.set(messageId, n);
            if (n <= 8) meguminScheduleBlocksRefresh(400);
            continue;
        }
        layoutRetries.delete(messageId);
        meguminDecorateMessageBody(hostOf(w), msg.mes, idx);
        const drawn = Boolean(w.querySelector(".meg-blocks"));
        if (!drawn) dropWrapper(ctx, messageId);
        setMarkersHidden(element, drawn);
    }
}

export let meguminBlocksRefreshTimer = null;
// Several things change a message — an edit, a swipe, an image landing, a
// Chomusuke read finishing. Every path funnels through here, and the coalescing
// keeps a burst to a single pass.
export function meguminScheduleBlocksRefresh(delay = 60) {
    if (meguminBlocksRefreshTimer) clearTimeout(meguminBlocksRefreshTimer);
    meguminBlocksRefreshTimer = setTimeout(() => {
        meguminBlocksRefreshTimer = null;
        try { meguminRefreshBlocksInChat(); }
        catch (e) { console.debug(`[${extensionName}] block refresh failed`, e); }
    }, delay);
}

export function attachBlockCards() {
    const ctx = getHostContext();
    if (!ctx) return;
    tagUnsubs.forEach(fn => { try { fn(); } catch (e) { /* already gone */ } });
    tagUnsubs = [];
    wrappers.clear();

    if (ctx.messages && typeof ctx.messages.registerTagInterceptor === "function") {
        for (const tagName of HIDDEN_TAGS) {
            tagUnsubs.push(ctx.messages.registerTagInterceptor({ tagName, removeFromMessage: true }, (payload) => {
                if (!payload || payload.isUser || payload.isStreaming) return;
                meguminScheduleBlocksRefresh(120);
            }));
        }
    }

    // Bubbles mount as the reader scrolls; a bubble that was never on screen
    // when the cards were drawn gets its card on the next scroll pass. Cheap:
    // a card that is already up to date is skipped by its stamp.
    if (!scrollBound) {
        scrollBound = true;
        document.addEventListener("scroll", () => meguminScheduleBlocksRefresh(250), { capture: true, passive: true });
    }
}

// Console aid (window.megumin.debugBlocks): what the card would hold for one
// message, without touching the chat.
export function meguminDebugBlocks(idx) {
    const msg = getContext().chat[idx];
    if (!msg) return { error: "no such message" };
    const reg = [...meguminRenderRegistry(), ...NOTEBOOK_CARD_DEFS];
    const div = document.createElement("div");
    let error = null;
    try { meguminDecorateMessageBody(div, msg.mes, idx); } catch (e) { error = String(e && e.stack || e); }
    return { registryTags: reg.map(r => r.tag), cardHtmlLength: div.innerHTML.length, hasCard: Boolean(div.querySelector(".meg-blocks")), error };
}
