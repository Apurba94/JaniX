// JaniX Mobile file system: projects live in the browser's IndexedDB (through
// LightningFS, which isomorphic-git also uses), under /projects/<name>.
// The functions mirror the desktop app's window.janix.fs bridge.
import FS from "@isomorphic-git/lightning-fs";

export const lfs = new FS("janix");
const pfs = lfs.promises;
export const PROJECTS = "/projects";
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "out", "__pycache__", ".venv", "venv", "target"]);
const MAX_OPEN_BYTES = 10 * 1024 * 1024;

export const join = (...parts) => ("/" + parts.join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
export const basename = (p) => p.split("/").pop();
export const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";

export function resolvePath(cwd, target) {
  const parts = (target.startsWith("/") ? target : `${cwd}/${target}`).split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}

async function stat(p) { try { return await pfs.stat(p); } catch { return null; } }
export async function exists(p) { return Boolean(await stat(p)); }
export async function isDir(p) { return (await stat(p))?.isDirectory() || false; }

export async function mkdirp(dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    const s = await stat(cur);
    if (!s) await pfs.mkdir(cur);
    else if (!s.isDirectory()) throw new Error(`${cur} is a file, not a folder.`);
  }
}

export async function readDir(dir) {
  const names = await pfs.readdir(dir);
  const entries = [];
  for (const name of names) {
    if (name === ".git") continue;
    const s = await stat(join(dir, name));
    if (s) entries.push({ name, path: join(dir, name), isDir: s.isDirectory() });
  }
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1));
}

export async function listFiles(root, limit = 20000) {
  const out = [];
  const walk = async (dir) => {
    if (out.length >= limit) return;
    for (const name of await pfs.readdir(dir)) {
      const full = join(dir, name);
      const s = await stat(full);
      if (!s) continue;
      if (s.isDirectory()) { if (!IGNORED_DIRS.has(name)) await walk(full); }
      else out.push(full.slice(root.length + 1));
      if (out.length >= limit) return;
    }
  };
  await walk(root);
  return out;
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export async function readFile(file) {
  const s = await pfs.stat(file);
  if (s.size > MAX_OPEN_BYTES) throw new Error(`${basename(file)} is larger than 10 MB.`);
  const bytes = await pfs.readFile(file);
  if (looksBinary(bytes)) throw new Error(`${basename(file)} looks like a binary file and cannot be edited as text.`);
  return new TextDecoder().decode(bytes);
}
export const readBytes = (file) => pfs.readFile(file);

export async function writeFile(file, data) {
  await mkdirp(dirname(file));
  await pfs.writeFile(file, data, typeof data === "string" ? "utf8" : undefined);
  return true;
}

export async function createFile(file) {
  if (await exists(file)) throw new Error(`${basename(file)} already exists.`);
  return writeFile(file, "");
}

export async function createFolder(dir) {
  if (await exists(dir)) throw new Error(`${basename(dir)} already exists.`);
  await mkdirp(dir);
  return true;
}

export async function remove(target) {
  const s = await pfs.stat(target);
  if (s.isDirectory()) {
    for (const name of await pfs.readdir(target)) await remove(join(target, name));
    await pfs.rmdir(target);
  } else {
    await pfs.unlink(target);
  }
  return true;
}

export async function copy(from, to) {
  const s = await pfs.stat(from);
  if (s.isDirectory()) {
    await mkdirp(to);
    for (const name of await pfs.readdir(from)) await copy(join(from, name), join(to, name));
  } else {
    await writeFile(to, await pfs.readFile(from));
  }
  return true;
}

export async function rename(from, to) {
  if (await exists(to)) throw new Error(`${basename(to)} already exists.`);
  try { await pfs.rename(from, to); }
  catch { await copy(from, to); await remove(from); }   // LightningFS cannot rename folders across parents
  return true;
}

export async function searchInFiles(root, query, { caseSensitive = false } = {}) {
  const results = [];
  const needle = caseSensitive ? query : query.toLowerCase();
  for (const rel of await listFiles(root)) {
    if (results.length >= 2000) break;
    const file = join(root, rel);
    let text;
    try {
      const s = await pfs.stat(file);
      if (s.size > 2 * 1024 * 1024) continue;
      const bytes = await pfs.readFile(file);
      if (looksBinary(bytes)) continue;
      text = new TextDecoder().decode(bytes);
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < 2000; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(needle);
      if (col >= 0) results.push({ path: file, rel, line: i + 1, column: col + 1, text: lines[i].slice(0, 400) });
    }
  }
  return results;
}

export async function listProjects() {
  await mkdirp(PROJECTS);
  return (await readDir(PROJECTS)).filter((e) => e.isDir).map((e) => e.name);
}

// First run: a small sample project so the app is never empty.
export async function ensureSample() {
  await mkdirp(PROJECTS);
  if ((await pfs.readdir(PROJECTS)).length) return null;
  const root = join(PROJECTS, "hello-janix");
  await writeFile(join(root, "README.md"), `# Hello, JaniX

Welcome to **JaniX** on your phone, by Janin A Apurba.

- Tap ☰ to open the Explorer, and ⋮ for every command.
- Open the **Terminal** and type \`help\`: run \`node hello.js\` or \`python hello.py\`.
- Clone a repository with \`git clone https://github.com/<user>/<repo>\`.
- Open the Markdown preview of this file from the ⋮ menu.

\`\`\`js
console.log("Write code. Ship faster.");
\`\`\`
`);
  await writeFile(join(root, "hello.js"), `// Run me from the terminal: node hello.js
function greet(name) {
  return \`Hello, \${name}!\`;
}

for (const person of ["Janin", "World"]) {
  console.log(greet(person));
}
`);
  await writeFile(join(root, "hello.py"), `# Run me from the terminal: python hello.py
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print([fib(i) for i in range(10)])
`);
  return root;
}
