// Browser plumbing shared by every spec: page setup, request recording, real
// touch input over CDP, and the small page-side helpers the specs call into.
const VIEWPORT = { width: 1280, height: 900 };

// The only third parties the site is allowed to talk to, and only ever for
// their own static files: the PDF/ZIP libraries. The web fonts used to sit
// here too and are deliberately not on the list any more — they are served
// from assets/, and leaving the old Google Fonts hosts in would mean a pasted
// <link> went straight through this check again. An allowlist only works as a
// tripwire while it is as short as the truth allows.
const THIRD_PARTY_ASSET_HOSTS = [
  "https://cdnjs.cloudflare.com/",
  "https://unpkg.com/",
  "https://cdn.jsdelivr.net/",
];

function allowedOrigin(url, origin) {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  if (origin && url.startsWith(origin)) return true;
  return THIRD_PARTY_ASSET_HOSTS.some((host) => url.startsWith(host));
}

export async function launchBrowser(chromium, { headed } = {}) {
  return chromium.launch({
    headless: !headed,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
}

export async function newPage(browser, { origin, blockCdn, failOnPageError = true } = {}) {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const requests = [];
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));

  if (blockCdn) {
    await context.route("**://cdnjs.cloudflare.com/**", (route) => route.abort("failed"));
  }

  const cdp = await context.newCDPSession(page);

  return {
    page,
    context,
    cdp,
    origin,
    pageErrors,
    consoleErrors,
    requests,
    url: (path) => origin + path,

    // Everything the browser sends must be either the page's own static assets
    // or one of the CDN library hosts. Any other origin is somewhere a user's
    // file could have gone.
    foreignRequests() {
      return requests.filter((r) => !allowedOrigin(r.url, origin));
    },

    // A page that never uploads anything cannot leak the bytes of a PDF, so
    // the strongest form of the promise is "there is no outbound body at all".
    requestsWithBody() {
      return requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method));
    },

    async dispose() {
      await context.close().catch(() => {});
    },
  };
}

/* ---------- input ---------- */

// Real touch input. Playwright's touchscreen only taps, so reorder gestures go
// through CDP with explicit touch points, the way a finger would.
// keepDown leaves the finger down so the caller can hold at an edge and watch
// the strip scroll underneath it.
async function touchDrag(t, from, to, { steps = 12, hold = 0, keepDown = false } = {}) {
  const point = (x, y) => [{ x, y, radiusX: 10, radiusY: 10, force: 1, id: 1 }];
  await t.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await t.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
    if (i % 3 === 0) await t.page.waitForTimeout(12);
  }
  if (hold) await t.page.waitForTimeout(hold);
  if (!keepDown) await t.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export { touchDrag };

// Playwright's own mouse pipeline produces pointerType "mouse".
export async function mouseDrag(t, from, to, { steps = 12 } = {}) {
  await t.page.mouse.move(from.x, from.y);
  await t.page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await t.page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps
    );
    await t.page.waitForTimeout(10);
  }
  await t.page.mouse.up();
}

/* ---------- files ---------- */

export async function addFiles(t, selector, files) {
  await t.page.locator(selector).setInputFiles(files);
  // The dropzone handler resets the input so the same file can be picked twice.
  await t.page.waitForFunction(
    (sel) => document.querySelector(sel)?.files?.length === 0,
    selector,
    { timeout: 5000 }
  ).catch(() => {});
}

// PDF chips paint their first page as a thumbnail once pdf.js answers, and that
// render rebuilds every chip, so a test that drags has to wait the queue out —
// otherwise the drag is (correctly) abandoned half way as an interrupted
// gesture. A file that cannot be rendered keeps its fallback tile for good, so
// this waits for the strip to stop being rebuilt rather than for every tile to
// be replaced. Watched with a MutationObserver, since a re-render replaces the
// nodes rather than counting them down.
export async function waitForThumbnails(page, timeout = 25000) {
  const watching = await page.evaluate(() => {
    const pending = document.querySelectorAll(".file-strip .chip-fallback").length;
    if (!pending) return false;
    if (!window.__stripObserver) {
      window.__stripChanges = 0;
      window.__stripObserver = new MutationObserver(() => window.__stripChanges++);
      window.__stripObserver.observe(document.querySelector(".file-strip"), {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    if (!window.__stripEnginePending) {
      window.__stripEnginePending = true;
      window.__stripEngineReady = false;
      // No thumbnail can appear before the engine has loaded, so waiting for
      // both removes the race with a slow CDN.
      loadPdfJs().then(
        () => (window.__stripEngineReady = true),
        () => (window.__stripEngineReady = true)
      );
    }
    return true;
  });
  if (!watching) return;

  await page
    .waitForFunction(
      () => {
        if (!window.__stripEngineReady) return false;
        if (window.__stripLast !== window.__stripChanges) {
          window.__stripLast = window.__stripChanges;
          window.__stripQuiet = 0;
          return false;
        }
        window.__stripQuiet = (window.__stripQuiet || 0) + 1;
        return window.__stripQuiet >= 3;
      },
      null,
      { timeout, polling: 250 }
    )
    .catch(() => {});
}

/* ---------- geometry ---------- */

export async function chipBoxes(page, selector = ".file-strip .chip") {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })
  );
}

// The chip's own remove button, clicked the way a person would: hover the chip
// until the button appears, then press it. It is clicked by coordinate rather
// than through a locator because the chip lifts 2px on hover, which leaves the
// button creeping for as long as the pointer is travelling towards it.
export async function clickChipRemove(t, fileName) {
  const chip = t.page.locator(`.file-strip .chip:has(.chip-name:text-is("${fileName}"))`);
  await chip.hover();
  await t.page.waitForTimeout(300);
  const box = await chip.locator(".chip-x").boundingBox();
  if (!box) throw new Error(`${fileName} has no remove button`);
  await t.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return chip;
}

// A grab point on the chip's picture: the left edge, clear of the name, the
// size, the "…" button and the remove button.
export function chipGrabPoint(box) {
  return { x: box.x + 14, y: box.y + box.height / 2 };
}

// Keeps dispatching moves at one spot, which is how the edge auto-scroll is
// triggered: the nudge only happens per move event.
export async function touchHoldAt(t, point, times = 8) {
  const pts = [{ x: point.x, y: point.y, radiusX: 10, radiusY: 10, force: 1, id: 1 }];
  for (let i = 0; i < times; i++) {
    await t.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts });
    await t.page.waitForTimeout(16);
  }
}
export async function touchStartAt(t, point) {
  await t.cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, radiusX: 10, radiusY: 10, force: 1, id: 1 }],
  });
}

export async function touchEnd(t) {
  await t.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/* ---------- page state ---------- */

export function statusText(t) {
  return t.page.locator("#status").innerText();
}

// Waits for the status line to say something matching `matcher` (a RegExp or a
// plain substring). The pattern is rebuilt inside the page, so it cannot drag
// any of this file's scope with it.
export async function waitForStatus(t, matcher, timeout = 30000) {
  const source = matcher instanceof RegExp ? matcher.source : matcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = matcher instanceof RegExp ? matcher.flags : "";
  await t.page.waitForFunction(
    ([src, fl]) => new RegExp(src, fl).test(document.getElementById("status")?.textContent || ""),
    [source, flags],
    { timeout }
  );
  return statusText(t);
}

export async function waitForResultBar(t, timeout = 30000) {
  await t.page.locator("#resultBar").waitFor({ state: "visible", timeout });
}

export async function readResultText(t) {
  return t.page.evaluate(() => document.querySelector(".result-text")?.textContent || "");
}

export async function chipNames(t) {
  return t.page.locator(".file-strip .chip .chip-name").allInnerTexts();
}

export async function cellNames(t) {
  return t.page.locator("#wsGrid .ws-cell .ws-filename").allInnerTexts();
}

export async function cellNumbers(t) {
  return t.page.locator("#wsGrid .ws-cell .ws-num").allInnerTexts();
}
