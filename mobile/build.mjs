// Builds JaniX Mobile into www/: bundles src/app.js with esbuild and copies the
// shared desktop styles, xterm's CSS, icons, the manifest and the service worker.
// `node build.mjs --serve` also serves www/ on http://localhost:5174 for testing (serve.mjs).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const out = "www";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["src/app.js"], bundle: true, format: "esm", splitting: true, outdir: out, chunkNames: "chunks/[name]-[hash]",
  minify: true, sourcemap: false, target: ["es2020", "safari15"], define: { global: "globalThis" }, logLevel: "warning",
});
cpSync("index.html", join(out, "index.html"));
cpSync("../src/renderer/styles.css", join(out, "janix.css"));    // the same look as JaniX for Windows
cpSync("src/mobile.css", join(out, "mobile.css"));
cpSync("node_modules/@xterm/xterm/css/xterm.css", join(out, "xterm.css"));
cpSync("public", out, { recursive: true });

// Service worker cache name changes with the content, so updates reach installed apps.
const files = [];
const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
walk(out);
const hash = createHash("sha256");
for (const f of files.sort()) hash.update(f).update(readFileSync(f));
const assets = files.map((f) => f.slice(out.length + 1).replace(/\\/g, "/")).filter((f) => f !== "sw.js");
const sw = readFileSync(join(out, "sw.js"), "utf8")
  .replace("__CACHE__", `janix-${hash.digest("hex").slice(0, 12)}`)
  .replace("__ASSETS__", JSON.stringify(["./", ...assets.filter((a) => a !== "index.html")]));
writeFileSync(join(out, "sw.js"), sw);
console.log(`built ${files.length} files into ${out}/`);

if (process.argv.includes("--serve")) await import("./serve.mjs");
