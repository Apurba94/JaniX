// Serves the built app (www/) on http://localhost:5174 for testing: `node serve.mjs`.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "www");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = readFileSync(join(root, p));
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(5174, () => console.log("JaniX Mobile on http://localhost:5174"));
