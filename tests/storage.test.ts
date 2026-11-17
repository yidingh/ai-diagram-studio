import { expect, it, afterEach } from "vitest";
import {
  readRecovery,
  writeRecovery,
  readKey,
  saveKey,
} from "../lib/tab-storage";
import { createEmptyDocument } from "../lib/diagram/document";
afterEach(() => sessionStorage.clear());
it("round trips a draft and key in separate records", () => {
  const state = {
    version: 1 as const,
    current: createEmptyDocument(),
    backup: null,
    undo: null,
  };
  writeRecovery(sessionStorage, state);
  saveKey(sessionStorage, "test-key");
  expect(readRecovery(sessionStorage)).toEqual(state);
  expect(readKey(sessionStorage)).toBe("test-key");
  expect(sessionStorage.getItem("diagram-studio:recovery")).not.toContain(
    "test-key",
  );
});
it("rejects corrupt saved data without overwriting it", () => {
  sessionStorage.setItem("diagram-studio:recovery", "broken");
  expect(() => readRecovery(sessionStorage)).toThrow();
  expect(sessionStorage.getItem("diagram-studio:recovery")).toBe("broken");
});
it("rejects empty XML in every saved snapshot", () => {
  const valid = {
    version: 1,
    current: createEmptyDocument(),
    backup: null,
    undo: null,
  };
  for (const state of [
    { ...valid, current: "" },
    { ...valid, backup: "" },
    { ...valid, undo: { before: "", after: valid.current } },
    { ...valid, undo: { before: valid.current, after: "" } },
  ]) {
    const encoded = JSON.stringify(state);
    sessionStorage.setItem("diagram-studio:recovery", encoded);
    expect(() => readRecovery(sessionStorage)).toThrow();
    expect(sessionStorage.getItem("diagram-studio:recovery")).toBe(encoded);
  }
});
it("propagates quota failure so the UI does not claim recovery is saved", () => {
  const storage = {
    setItem: () => {
      throw new Error("quota");
    },
  } as unknown as Storage;
  expect(() =>
    writeRecovery(storage, {
      version: 1,
      current: createEmptyDocument(),
      backup: null,
      undo: null,
    }),
  ).toThrow("quota");
});
