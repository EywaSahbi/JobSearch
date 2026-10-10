export const CAPS = Object.freeze({
  localReadOnly: Object.freeze({ writes: false, network: false }),
  webSearchOnly: Object.freeze({ writes: false, network: "search" }),
  networkReadOnly: Object.freeze({ writes: false, network: "fetch" }),
  workspaceWrite: Object.freeze({ writes: true, network: "fetch" }),
});

export const KNOWN_KINDS = Object.freeze(["pdf", "research", "evaluate", "fix-portal"]);

const KIND_CAPABILITIES = Object.freeze({
  pdf: CAPS.localReadOnly,
  research: CAPS.networkReadOnly,
  evaluate: CAPS.workspaceWrite,
  "fix-portal": CAPS.workspaceWrite,
});

export function capabilitiesFor(kind) {
  return Object.hasOwn(KIND_CAPABILITIES, kind) ? KIND_CAPABILITIES[kind] : CAPS.localReadOnly;
}
