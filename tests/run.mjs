// Regression suite runner.
//
//   node tests/run.mjs                  run everything
//   node tests/run.mjs --filter merge   run matching tests only
//   node tests/run.mjs --headed         watch it happen
//   node tests/run.mjs --list           list test names
//
// Uses only Node built-ins plus a Playwright install that already exists on the
// machine (see tests/lib/playwright.mjs). Nothing is installed into the repo.
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startServer } from "./lib/server.mjs";
import { loadPlaywright } from "./lib/playwright.mjs";
import { collect, setSpecFile } from "./lib/harness.mjs";
import { launchBrowser, newPage } from "./lib/browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const specsDir = join(here, "specs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const filter = value("--filter");
const headed = flag("--headed");

const useColor = Boolean(process.stdout.isTTY) && !args.includes("--no-color");
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const dim = (t) => paint("90", t);
const bold = (t) => paint("1", t);

function reportFailure(err) {
  const text = String(err && err.stack ? err.stack : err);
  for (const line of text.split("\n").slice(0, 14)) console.log("         " + line);
}

async function main() {
  const specFiles = (await readdir(specsDir)).filter((f) => f.endsWith(".spec.mjs")).sort();
  for (const file of specFiles) {
    setSpecFile(file);
    await import(pathToFileURL(join(specsDir, file)).href);
  }

  let tests = collect();
  if (filter) {
    const needle = filter.toLowerCase();
    tests = tests.filter((t) => `${t.file} ${t.name}`.toLowerCase().includes(needle));
  }
  if (flag("--list")) {
    for (const t of tests) console.log(`${t.file}  ${t.name}`);
    return 0;
  }
  if (!tests.length) {
    console.log("No tests matched.");
    return 0;
  }

  const { chromium } = await loadPlaywright();
  const server = await startServer(repoRoot);
  const browser = await launchBrowser(chromium, { headed });

  const started = Date.now();
  const failures = [];
  const knownBugs = [];
  let passed = 0;
  let lastFile = "";

  for (const entry of tests) {
    if (entry.file !== lastFile) {
      lastFile = entry.file;
      console.log(`\n${bold(lastFile)}`);
    }
    const at = Date.now();
    const context = await newPage(browser, {
      origin: server.origin,
      // The tools must never talk to anything but the CDN library hosts; a
      // spec can flip this on to prove the failure path explains itself.
      blockCdn: entry.blockCdn === true,
      failOnPageError: entry.pageErrors !== false,
    });
    try {
      if (entry.path) await context.page.goto(context.url(entry.path), { waitUntil: "domcontentloaded" });
      await entry.fn(context);
      passed++;
      if (entry.knownBug) {
        knownBugs.push({ entry, failing: false });
        console.log(`  ${yellow("ok*")} ${entry.name} ${dim("known bug is fixed — drop the marker")}`);
      } else {
        console.log(`  ${green("ok")} ${entry.name} ${dim(Date.now() - at + "ms")}`);
      }
    } catch (err) {
      if (entry.knownBug) {
        knownBugs.push({ entry, failing: true, err });
        console.log(`  ${yellow("known bug")} ${entry.name} ${dim(Date.now() - at + "ms")}`);
        console.log(yellow("         " + entry.knownBug));
      } else {
        failures.push({ entry, err });
        console.log(`  ${red("FAIL")} ${entry.name} ${dim(Date.now() - at + "ms")}`);
        reportFailure(err);
      }
    } finally {
      await context.dispose();
    }
  }

  await browser.close();
  await server.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");
  for (const { entry } of failures) console.log(`  ${red("x")} ${entry.file} — ${entry.name}`);
  const stillBroken = knownBugs.filter((k) => k.failing);
  if (stillBroken.length) {
    console.log(yellow(`${stillBroken.length} known bug(s) still failing:`));
    for (const { entry } of stillBroken) console.log(yellow(`  ! ${entry.file} — ${entry.knownBug}`));
  }
  const summary = [
    failures.length ? red(`${failures.length} failing`) : null,
    green(`${passed} passing`),
    stillBroken.length ? yellow(`${stillBroken.length} known bug`) : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(summary + dim(`  (${seconds}s)`));
  return failures.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(String(err && err.stack ? err.stack : err)));
    process.exit(2);
  }
);
