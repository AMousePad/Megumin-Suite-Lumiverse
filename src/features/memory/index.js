// ─────────────────────────────────────────────────────────────────────────────
// Memory Core — not part of the Lumiverse port.
//
// Lumiverse has its own long-term memory, so the suite's is left out. The
// prompt builder still imports the retrieval helper; the memory branch in
// buildBaseDict is switched off, so this is never reached, but the import has
// to resolve.
// ─────────────────────────────────────────────────────────────────────────────

export function memGetRelevantVaultEntries() { return []; }
