export const EDITOR_ORIGIN = "https://embed.diagrams.net";
export const READY_TIMEOUT_MS = 20_000;
export const OPERATION_TIMEOUT_MS = 10_000;
export const MAX_XML_BYTES = 512 * 1024;
export const MAX_XML_ELEMENTS = 2_000;
export const MAX_XML_DEPTH = 32;
// Allows worst-case JSON escaping of a 512 KiB XML string plus envelope.
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

// Generation limits share this module with editor limits.
export const MAX_PROMPT_CHARS = 4_000;
export const MAX_GENERATE_BODY_BYTES = 32 * 1024;
export const MAX_FRAGMENT_BYTES = 128 * 1024;
// A bounded JSON envelope permits worst-case escaping of the fragment string.
export const MAX_MODEL_ENVELOPE_BYTES = 6 * MAX_FRAGMENT_BYTES + 1024;
export const MAX_GENERATE_RESPONSE_BYTES = 6 * MAX_XML_BYTES + 4096;
export const MIN_NODES = 3;
export const MAX_NODES = 12;
export const MAX_EDGES = 24;
export const MAX_LABEL_CHARS = 120;
export const MAX_ID_CHARS = 80;
export const MAX_POSITION = 4_000;
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 400;
export const MIN_HEIGHT = 30;
export const MAX_HEIGHT = 240;
export const SERVER_DEADLINE_MS = 45_000;
export const BROWSER_DEADLINE_MS = 50_000;
export const MAX_OUTPUT_TOKENS = 8_000;
