// A very small test registry. No framework, no globals, no dependencies:
// a spec file just calls test() at import time and the runner collects them.
import assert from "node:assert/strict";

const registry = [];
let currentFile = "";

export function setSpecFile(name) {
  currentFile = name;
}

export function test(name, fn, options = {}) {
  registry.push({ name, fn, file: currentFile, ...options });
}

export function collect() {
  return registry;
}

export { assert };

// Fails with a message instead of throwing a bare "expected undefined".
export function expect(actual, message) {
  if (!actual) assert.fail(message || "expected a truthy value");
  return actual;
}

// Names the case that broke, even when the assertion sits several frames deep
// inside a helper.
export async function step(label, fn) {
  try {
    return await fn();
  } catch (err) {
    err.message = `${label}: ${err.message}`;
    throw err;
  }
}
