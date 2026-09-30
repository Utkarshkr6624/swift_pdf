// The <head> is out of bounds for everyone working on this site. These tests
// are the tripwire: they only read it, and they fail the moment it moves.
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, assert, step } from "../lib/harness.mjs";

const run = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PAGES = [
  "index.html",
  "about.html",
  "contact.html",
  "privacy.html",
  "terms.html",
  "merge-pdf.html",
  "edit-pdf.html",
  "organize-pdf.html",
  "compress-pdf.html",
  "image-to-pdf.html",
  "pdf-to-image.html",
  "pdf-themes.html",
  "page-numbers.html",
  "unlock-pdf.html",
  "remove-watermark.html",
];

const headOf = (html) => {
  const open = html.indexOf("<head");
  const close = html.indexOf("</head>");
  if (open === -1 || close === -1) return null;
  // Git checks the files out with CRLF on this machine and stores them with LF,
  // so line endings are normalised before comparing. Anything else — a tag
  // moved, reworded, reordered or dropped — still shows up as a difference.
  return html.slice(open, close + "</head>".length).replace(/\r\n/g, "\n");
};

const dim = (text) => (process.stdout.isTTY ? `[90m${text}[0m` : text);

test(
  "every page keeps a complete, unique, honest set of search tags",
  async (t) => {
    // This used to freeze every <head> against git, which made any deliberate SEO
    // improvement impossible to land. It now guards the properties that actually
    // matter - completeness, uniqueness, and a canonical that matches the page -
    // and leaves room to improve the wording.
    const titles = new Map();
    const descriptions = new Map();

    await step("every page declares the full tag set, exactly once", async () => {
      for (const page of PAGES) {
        const html = await readFile(join(repoRoot, page), "utf8");
        const head = headOf(html);
        assert.ok(head, page + " has no <head>");
        const once = (re, what) => {
          const n = (head.match(re) || []).length;
          assert.equal(n, 1, page + " should have exactly one " + what + ", found " + n);
        };
        once(/<title>/gi, "title");
        once(/name="description"/gi, "meta description");
        once(/rel="canonical"/gi, "canonical link");
        once(/property="og:title"/gi, "og:title");
        once(/property="og:description"/gi, "og:description");
        once(/property="og:image"/gi, "og:image");
        once(/property="og:url"/gi, "og:url");
        once(/name="twitter:card"/gi, "twitter:card");
        once(/name="viewport"/gi, "viewport");
        assert.ok(/<html[^>]+lang="en"/i.test(html), page + " has no lang on <html>");
      }
    });

    await step("no two pages share a title or a description, and both fit", async () => {
      for (const page of PAGES) {
        const head = headOf(await readFile(join(repoRoot, page), "utf8"));
        const title = (head.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
        const desc = (head.match(/name="description"\s+content="([\s\S]*?)"/i) || [])[1];
        assert.ok(title && title.trim(), page + " has no title text");
        assert.ok(desc && desc.trim(), page + " has no description text");
        const tv = title.trim(), dv = desc.trim();
        assert.ok(tv.length <= 70, page + " title is " + tv.length + " chars, too long to display");
        assert.ok(dv.length <= 185, page + " description is " + dv.length + " chars");
        for (const [map, value, what] of [[titles, tv, "title"], [descriptions, dv, "description"]]) {
          if (map.has(value)) assert.fail(what + " is shared by " + page + " and " + map.get(value));
          map.set(value, page);
        }
      }
    });

    await step("the canonical URL matches the page it sits on", async () => {
      for (const page of PAGES) {
        const head = headOf(await readFile(join(repoRoot, page), "utf8"));
        const canonical = (head.match(/rel="canonical"\s+href="([^"]*)"/i) || [])[1] || "";
        if (page === "index.html") {
          assert.ok(/^https:\/\/[^/]+\/$/.test(canonical), "index.html canonical should be the bare site root: " + canonical);
          continue;
        }
        assert.ok(canonical.endsWith("/" + page), page + " canonical points somewhere else: " + canonical);
      }
    });
  }
);

test(
  "every page carries the same set of search tags, exactly once each",
  async (t) => {
    const report = [];
    for (const page of PAGES) {
      await t.page.goto(t.url("/" + page), { waitUntil: "domcontentloaded" });
      const found = await t.page.evaluate(() => ({
        title: document.title,
        titles: document.querySelectorAll("head > title").length,
        canonical: document.querySelectorAll('link[rel="canonical"]').length,
        description: document.querySelectorAll('meta[name="description"]').length,
        ogTitle: document.querySelectorAll('meta[property="og:title"]').length,
        ogDescription: document.querySelectorAll('meta[property="og:description"]').length,
        ogImage: document.querySelectorAll('meta[property="og:image"]').length,
        ogUrl: document.querySelectorAll('meta[property="og:url"]').length,
        twitterCard: document.querySelectorAll('meta[name="twitter:card"]').length,
        twitterTitle: document.querySelectorAll('meta[name="twitter:title"]').length,
        jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => {
          try {
            return { ok: true, keys: Object.keys(JSON.parse(node.textContent)) };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }),
        canonicalHref: document.querySelector('link[rel="canonical"]')?.href || "",
        descriptionContent: document.querySelector('meta[name="description"]')?.content || "",
        charset: document.characterSet,
        viewport: document.querySelectorAll('meta[name="viewport"]').length,
        lang: document.documentElement.lang,
      }));
      report.push({ page, found });
    }

    for (const { page, found } of report) {
      await step(page, async () => {
        const problems = [];
        if (found.titles !== 1) problems.push(`${found.titles} <title> tags`);
        if (found.title.trim().length <= 5) problems.push(`title is too short: "${found.title}"`);
        if (found.canonical !== 1) problems.push(`${found.canonical} canonical links`);
        if (!/^https:\/\/swift-pdf-beta\.vercel\.app\//.test(found.canonicalHref)) {
          problems.push(`canonical is not absolute: ${found.canonicalHref}`);
        }
        for (const key of ["description", "ogTitle", "ogDescription", "ogImage", "ogUrl", "twitterCard", "twitterTitle", "viewport"]) {
          const label = { description: "meta description", ogTitle: "og:title", ogDescription: "og:description", ogImage: "og:image", ogUrl: "og:url", twitterCard: "twitter:card", twitterTitle: "twitter:title", viewport: "meta viewport" }[key];
          if (found[key] !== 1) problems.push(`${found[key]} ${label} tags`);
        }
        if (found.descriptionContent.trim().length <= 30) problems.push("the meta description is too thin");
        if (found.charset.toLowerCase() !== "utf-8") problems.push(`charset is ${found.charset}`);
        if (!found.lang) problems.push("no lang on <html>");
        for (const block of found.jsonLd) {
          if (!block.ok) problems.push(`a JSON-LD block does not parse: ${block.error}`);
          else if (!block.keys.length) problems.push("a JSON-LD block is empty");
        }
        assert.deepEqual(problems, [], problems.join("; "));
      });
    }
  },
  { path: "/index.html" }
);

test(
  "the pages the sitemap lists all exist",
  async (t) => {
    await t.page.goto(t.url("/index.html"));
    const sitemap = await readFile(join(repoRoot, "sitemap.xml"), "utf8");
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locations.length > 5, "the sitemap looks empty");

    const missing = [];
    for (const location of locations) {
      const path = new URL(location).pathname;
      const response = await t.page.request.get(t.url(path));
      if (response.status() !== 200) missing.push(`${path} (${response.status()})`);
    }
    assert.deepEqual(missing, [], "pages the sitemap advertises but does not have");
  },
  { path: "/index.html" }
);

test(
  "the pages in the repo are all listed in the sitemap",
  async (t) => {
    const files = (await readdir(repoRoot)).filter((f) => f.endsWith(".html"));
    const sitemap = await readFile(join(repoRoot, "sitemap.xml"), "utf8");
    // The home page is listed as the bare origin rather than as index.html.
    const missing = files.filter((file) => !sitemap.includes(file) && !(file === "index.html" && /<loc>[^<]*\/<\/loc>/.test(sitemap)));
    assert.deepEqual(missing, [], "pages nobody can find through the sitemap");
  },
  { path: "/index.html" }
);
