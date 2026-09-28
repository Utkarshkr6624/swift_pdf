// Minimal static file server for the regression suite.
// Node built-ins only: the project has no dependencies and this must not add any.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export async function startServer(rootDir) {
  const root = normalize(rootDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const target = normalize(join(root, rel));
      // normalize() has already collapsed any "..", but a symlinked or
      // absolute-ish path could still escape, so compare prefixes explicitly.
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const info = await stat(target);
      if (info.isDirectory()) {
        res.writeHead(301, { location: rel + "/" }).end();
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        "content-type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
