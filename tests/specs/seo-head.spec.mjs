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
  "no page's <head> has changed since the last commit",
  async (t) => {
    await step("every page has a head at all", async () => {
      for (const page of PAGES) {
        const html = await readFile(join(repoRoot, page), "utf8");
        assert.ok(headOf(html), `${page} has no <head>`);
      }
    });

    try {
      await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
    } catch {
      console.log(dim("       (no git history here, so there is nothing to compare against)"));
      return;
    }

    const changed = [];
    for (const page of PAGES) {
      const { stdout } = await run("git", ["show", `HEAD:${page}`], { cwd: repoRoot }).catch(() => ({ stdout: null }));
      if (stdout === null) {
        changed.push(`${page} is not in the last commit`);
        continue;
      }
      const before = headOf(stdout);
      const after = headOf(await readFile(join(repoRoot, page), "utf8"));
      if (before !== after) changed.push(page);
    }
    assert.deepEqual(changed, [], "these pages no longer have the head they were committed with");
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
