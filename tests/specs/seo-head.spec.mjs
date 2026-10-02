// The <head> is out of bounds for everyone working on this site. These tests
// are the tripwire: they only read it, and they fail the moment it moves.
import { access, readdir, readFile } from "node:fs/promises";
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

// Every page the site ships, found on disk instead of listed here, so a page
// added later is covered without anyone remembering to add it to PAGES too.
const everyPageFile = async () =>
  (await readdir(repoRoot)).filter((f) => f.endsWith(".html")).sort();

const linksIn = (html) =>
  [...(headOf(html) || "").matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);

const hrefOf = (tag) => (tag.match(/href="([^"]*)"/i) || [])[1] || "";

const hostOf = (href) => {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return href.toLowerCase();
  }
};

const hasScheme = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

// Google is not a host this site is allowed to reach. The two font hosts are
// gone because the font files are served from assets/, and nothing else on this
// site has any business talking to Google either.
const isGoogle = (href) => {
  const host = hostOf(href);
  return host === "google" || host.endsWith(".google") ||
    host.includes("googleapis") || host.includes("gstatic");
};

// The two font hosts named outright, so a bare mention in a comment, a CSS
// @import or a hand-written URL is caught even with no link tag to parse.
const GOOGLE_FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

// A font the site serves itself: a local path under this origin rather than an
// absolute URL pointing somewhere else.
const localFontHrefs = (html) =>
  linksIn(html)
    .filter((tag) => /rel="(?:stylesheet|preload)"/i.test(tag))
    .map(hrefOf)
    .filter((href) => href && !hasScheme(href) && !href.startsWith("//") && /font/i.test(href))
    .map((href) => href.split(/[?#]/)[0]);

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

    await step("a page warms the CDN connection only when it can reach it", async () => {
      // pdf.js, pdf-lib and JSZip are only fetched when a tool is first used, so
      // the connection to the CDN is opened while the page is still loading
      // instead of on the click. A page that pulls in pdf-core.js can reach the
      // CDN; a content page never can and should not pay for the handshake.
      // Google is not on that list. The fonts are served from this origin now,
      // so a preconnect to a Google host opens a connection nothing ever uses,
      // and it is the exact thing that would put a third party back in the path.
      for (const page of PAGES) {
        const html = await readFile(join(repoRoot, page), "utf8");
        const preconnects = linksIn(html)
          .filter((tag) => /rel="preconnect"/i.test(tag))
          .map(hrefOf);
        const google = preconnects.filter(isGoogle);
        assert.deepEqual(google, [], page + " preconnects to a Google host: " + google.join(", "));
        const cdn = preconnects.filter((href) => hostOf(href) === "cdnjs.cloudflare.com");
        const usesCdn = /<script src="pdf-core\.js"/.test(html);
        assert.equal(
          cdn.length,
          usesCdn ? 1 : 0,
          page + (usesCdn ? " loads pdf-core.js but does not preconnect exactly once to the CDN" : " never reaches the CDN but still preconnects to it")
        );
      }
    });

    await step("nothing in the site points at a Google host", async () => {
      // The web fonts are served from this origin. Any surviving reference to
      // either font host - a stylesheet link, a preconnect, an @import, a
      // leftover comment - is a third party back in the load path, and it hands
      // that third party the reader's IP address and the list of pages visited.
      // styles.css is read as well as the pages, because an @import there would
      // bring the dependency back without a single link tag on any page.
      const files = [...(await everyPageFile()), "styles.css"];
      for (const file of files) {
        const text = await readFile(join(repoRoot, file), "utf8");
        const lower = text.toLowerCase();
        for (const host of GOOGLE_FONT_HOSTS) {
          const at = lower.indexOf(host);
          assert.equal(at, -1, file + " line " + (lower.slice(0, at).split("\n").length) +
            " still names " + host + ": " + text.slice(at - 40, at + host.length + 20).replace(/\s+/g, " "));
        }
        for (const url of text.match(/https?:\/\/[^\s"'<>)]+/g) || []) {
          assert.ok(!isGoogle(url), file + " still loads " + url);
        }
      }
    });

    await step("every page takes its fonts from this origin", async () => {
      // Self-hosting is only true if the file the browser fetches is served by
      // this site. That is checked on every page in the repository rather than
      // on the SEO list, so a page added later cannot quietly ship without the
      // stylesheet that carries the fonts, or with a font link of its own that
      // the other pages do not have.
      const css = await readFile(join(repoRoot, "styles.css"), "utf8");
      const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/gi)].map((m) => m[1]);
      assert.ok(faces.length > 0, "styles.css declares no @font-face, so the site's own fonts would never load");
      const faceFiles = new Set();
      for (const face of faces) {
        for (const [, src] of face.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
          assert.ok(!hasScheme(src) && !src.startsWith("//"), "an @font-face still loads " + src + " from another origin");
          assert.ok(!isGoogle(src), "an @font-face still loads " + src);
          assert.ok(/font/i.test(src), "an @font-face points at " + src + ", which is not one of the font files");
          faceFiles.add(src);
        }
      }
      const missing = [];
      for (const src of faceFiles) {
        await access(join(repoRoot, src)).catch(() => missing.push(src));
      }
      assert.deepEqual(missing, [], "font files styles.css points at that are not in the repository");

      const byPage = new Map();
      for (const page of await everyPageFile()) {
        const html = await readFile(join(repoRoot, page), "utf8");
        const styles = linksIn(html).filter((tag) => /rel="stylesheet"/i.test(tag)).map(hrefOf);
        assert.ok(styles.includes("styles.css"), page + " does not link styles.css, so it gets none of the site's fonts");
        for (const href of styles.filter((h) => hasScheme(h) || h.startsWith("//"))) {
          assert.fail(page + " loads its stylesheet from another origin: " + href);
        }
        byPage.set(page, localFontHrefs(html).sort().join(", "));
      }
      for (const [page, list] of byPage) {
        const odd = [...byPage].find(([other]) => other !== page && byPage.get(other) !== list);
        if (odd) {
          assert.fail("the font link is not the same everywhere: " + page + " loads [" + list +
            "] but " + odd[0] + " loads [" + odd[1] + "]");
        }
      }
    });
  }
);

test(
  "every page carries the same set of search tags, exactly once each",
  async (t) => {
    const report = [];
    for (const page of PAGES) {
      const seen = t.requests.length;
      await t.page.goto(t.url("/" + page), { waitUntil: "load" });
      const fetched = t.requests.slice(seen).map((r) => r.url);
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
      report.push({ page, found, fetched });
    }

    for (const { page, found, fetched } of report) {
      await step(page, async () => {
        const problems = [];
        // Only the font hosts here. Chromium opens its own connection to a Google
        // ad-measurement endpoint that no page asks for, and that is the browser
        // talking, not the site - so the guard is about what the markup chooses.
        const google = fetched.filter((url) => GOOGLE_FONT_HOSTS.some((host) => url.includes(host)));
        if (google.length) problems.push(`loaded a font from Google: ${[...new Set(google)].join(", ")}`);
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
