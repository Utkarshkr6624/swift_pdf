// Sanity checks that every tool page boots cleanly and stays local.
import { test, assert } from "../lib/harness.mjs";

const PAGES = [
  "/index.html",
  "/merge-pdf.html",
  "/edit-pdf.html",
  "/organize-pdf.html",
  "/compress-pdf.html",
  "/image-to-pdf.html",
  "/pdf-to-image.html",
  "/pdf-themes.html",
  "/page-numbers.html",
  "/unlock-pdf.html",
  "/remove-watermark.html",
];

test(
  "every page loads with no uncaught error and no missing local asset",
  async (t) => {
    const missing = [];
    for (const path of PAGES) {
      const response = await t.page.goto(t.url(path), { waitUntil: "load" });
      assert.equal(response.status(), 200, `${path} returned ${response.status()}`);
      const failed = await t.page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((entry) => entry.transferSize === 0 && !entry.name.startsWith("data:"))
          .map((entry) => entry.name)
      );
      for (const url of failed) {
        // A zero transfer size also shows up for small cache hits, so only
        // complain about things that are actually this project's files.
        if (url.startsWith(t.origin)) missing.push(`${path} -> ${url}`);
      }
    }
    assert.deepEqual(missing, [], "local assets that failed to load");
    assert.deepEqual(t.pageErrors, [], "uncaught page errors");
  },
  { path: "/index.html" }
);

test(
  "a fresh page talks to the site and the CDN only, never anywhere else",
  async (t) => {
    await t.page.goto(t.url("/merge-pdf.html"), { waitUntil: "load" });
    assert.deepEqual(t.foreignRequests(), [], "requests to a third-party origin");
    assert.deepEqual(t.requestsWithBody(), [], "requests that carry a payload");
  },
  { path: "/merge-pdf.html" }
);
