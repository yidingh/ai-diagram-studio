export const EDITOR_ORIGIN = "https://embed.diagrams.net";
export const READY_TIMEOUT_MS = 20_000;
export const OPERATION_TIMEOUT_MS = 10_000;
export const MAX_XML_BYTES = 512 * 1024;
export const MAX_XML_ELEMENTS = 2_000;
export const MAX_XML_DEPTH = 32;
// Allows worst-case JSON escaping of a 512 KiB XML string plus envelope.
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

// A 1,600px dense raster can exceed the final HTTP budget before browser compression.
export const MAX_PNG_MESSAGE_BYTES = 20 * 1024 * 1024;
