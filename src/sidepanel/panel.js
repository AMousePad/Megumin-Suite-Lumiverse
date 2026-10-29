// ─────────────────────────────────────────────────────────────────────────────
// Side panel — not part of the Lumiverse port.
//
// The SillyTavern build can pull the tracker blocks out of the chat into a
// docked panel. That feature is left out here, so this module answers the few
// questions the rest of the code asks of it with "there is no panel": nothing
// is taken out of the in-chat card, and refreshing it does nothing.
// ─────────────────────────────────────────────────────────────────────────────

export function getSidePanelSettings() { return { enabled: false, hideInline: false, sections: {} }; }
export function refreshSidePanel() {}
export function refreshPresentBar() {}
