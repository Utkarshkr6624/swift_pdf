// Playwright is not a project dependency and must not become one. Resolve it
// from the environment at run time: an explicit path, a normal resolution, or
// the npm npx cache that Playwright is already installed in.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function fromNpxCache() {
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  if (!base) return [];
  const cache = join(base, "npm-cache", "_npx");
  if (!existsSync(cache)) return [];
  const found = [];
  for (const entry of readdirSync(cache)) {
    const dir = join(cache, entry, "node_modules", "playwright");
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    let version = "";
    try {
      version = JSON.parse(readFileSync(manifest, "utf8")).version || "";
    } catch {}
    // Prefer a stable release: "1.63.0" before "1.64.0-alpha-…".
    const preRelease = version.includes("-") ? 1 : 0;
    found.push({ dir, preRelease, version });
  }
  found.sort((a, b) => a.preRelease - b.preRelease || b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found.map((f) => f.dir);
}

// Node cannot import a directory, so resolve the package's own ESM entry.
function entryFor(dir) {
  if (existsSync(join(dir, "index.mjs"))) return pathToFileURL(join(dir, "index.mjs")).href;
  const requireFromDir = createRequire(pathToFileURL(join(dir, "package.json")));
  return pathToFileURL(requireFromDir.resolve("playwright")).href;
}

export async function loadPlaywright() {
  const attempts = [];
  if (process.env.SWIFTPDF_PLAYWRIGHT) attempts.push(process.env.SWIFTPDF_PLAYWRIGHT);
  attempts.push(...fromNpxCache());
  attempts.push(null); // plain "playwright", in case the caller has NODE_PATH set up

  const tried = [];
  for (const dir of attempts) {
    const specifier = dir ? entryFor(dir) : "playwright";
    try {
      return await import(specifier);
    } catch (err) {
      tried.push(`${dir || "playwright"} (${err.code || err.message})`);
    }
  }
  throw new Error(
    "Could not load Playwright. Install it anywhere and point SWIFTPDF_PLAYWRIGHT " +
      "at the directory that contains it.\nTried:\n  " + tried.join("\n  ")
  );
}
