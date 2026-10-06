// A request that never answers must fail after the time limit, not hang the page forever
// (2026-10-06: Refresh sat on "updating..." until the app was closed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGet } from "../www/js/transport.js";

test("a request ESPN never answers fails after the time limit", async () => {
  const realFetch = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  });
  try {
    const get = makeGet(null, { timeoutMs: 50 });
    await assert.rejects(get("https://example.test/x", {}), /didn't answer within/);
    assert.ok(aborted, "the stalled request is cancelled, not left running");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a normal answer still comes through", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: 1 }) });
  try {
    assert.deepEqual(await makeGet(null, { timeoutMs: 50 })("https://example.test/x", {}),
                     { status: 200, data: { ok: 1 } });
  } finally {
    globalThis.fetch = realFetch;
  }
});
