// JaniX main process: window, menus, files, settings and the integrated terminal.
"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");
const pty = require("@lydell/node-pty");
const { pathToFileURL } = require("node:url");

const APP_ROOT = path.join(__dirname, "..");
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const MAX_OPEN_BYTES = 25 * 1024 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "out", "__pycache__",
  ".venv", "venv", ".cache", ".idea", ".vs", "target", "coverage", ".expo", ".gradle"]);
const DEFAULT_SETTINGS = {
  theme: "janix-dark", fontSize: 14, wordWrap: "off", minimap: true, tabSize: 4,
  sidebarVisible: true, lastFolder: null, recentFiles: [], recentFolders: [],
  fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace", lineNumbers: "on", renderWhitespace: "selection",
  autoSave: "off", cursorStyle: "line", terminalShell: "powershell.exe", terminalFontSize: 13,
};

// Serve the app from app://janix/ rather than file:// so Monaco's web workers share
// the page's origin and load normally.
protocol.registerSchemesAsPrivileged([{ scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win = null;
let allowClose = false;
const terminals = new Map();
let nextTerminalId = 1;

// ------------------------------------------------------------------ settings
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}
let settings = DEFAULT_SETTINGS;

function remember(listKey, item, limit = 12) {
  settings[listKey] = [item, ...settings[listKey].filter((x) => x !== item)].slice(0, limit);
  saveSettings(settings);
  buildMenu();
}

// ------------------------------------------------------------------ files
function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

async function readDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => !(e.isDirectory() && e.name === ".git"))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isDir ? -1 : 1));
}

async function listFiles(root, limit = 25000) {
  const out = [];
  const walk = async (dir) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) await walk(full); }
      else out.push(path.relative(root, full));
    }
  };
  await walk(root);
  return out;
}

async function searchInFiles(root, query, { caseSensitive = false, maxResults = 2000 } = {}) {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const results = [];
  for (const rel of await listFiles(root)) {
    if (results.length >= maxResults) break;
    const full = path.join(root, rel);
    let buffer;
    try {
      const stat = await fsp.stat(full);
      if (stat.size > 2 * 1024 * 1024) continue;
      buffer = await fsp.readFile(full);
    } catch { continue; }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(needle);
      if (col >= 0) results.push({ path: full, rel, line: i + 1, column: col + 1, text: lines[i].slice(0, 300) });
    }
  }
  return results;
}

// ------------------------------------------------------------------ IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

handle("settings:get", () => settings);
handle("settings:set", (patch) => { settings = { ...settings, ...patch }; saveSettings(settings); buildMenu(); return settings; });

handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  remember("recentFolders", r.filePaths[0]);
  return r.filePaths[0];
});
handle("dialog:openFiles", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  return r.canceled ? [] : r.filePaths;
});
handle("dialog:saveAs", async (suggested) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested || undefined });
  return r.canceled ? null : r.filePath;
});
handle("dialog:confirm", async ({ message, detail, buttons }) => {
  const r = await dialog.showMessageBox(win, { type: "question", message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
  return r.response;
});
handle("dialog:prompt-error", async (message) => { await dialog.showMessageBox(win, { type: "error", message }); });

handle("fs:readDir", readDir);
handle("fs:listFiles", listFiles);
handle("fs:search", searchInFiles);
handle("fs:readFile", async (file) => {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_OPEN_BYTES) throw new Error(`${path.basename(file)} is larger than 25 MB.`);
  const buffer = await fsp.readFile(file);
  if (looksBinary(buffer)) throw new Error(`${path.basename(file)} looks like a binary file and cannot be edited as text.`);
  remember("recentFiles", file);
  return buffer.toString("utf8");
});
handle("fs:writeFile", async (file, text) => { await fsp.writeFile(file, text, "utf8"); remember("recentFiles", file); return true; });
handle("fs:createFile", async (file) => { await fsp.writeFile(file, "", { flag: "wx" }); return true; });
handle("fs:createFolder", async (dir) => { await fsp.mkdir(dir); return true; });
handle("fs:rename", async (from, to) => {
  if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists.`);
  await fsp.rename(from, to); return true;
});
handle("fs:trash", async (target) => { await shell.trashItem(target); return true; });
handle("fs:reveal", (target) => { shell.showItemInFolder(target); return true; });
handle("fs:exists", (target) => fs.existsSync(target));

// The renderer asks before closing when tabs have unsaved changes.
ipcMain.on("app:close-confirmed", () => { allowClose = true; win?.close(); });

// ------------------------------------------------------------------ terminal
// A real pseudo-terminal (ConPTY on Windows): colours, interactive prompts,
// full-screen programs and Ctrl+C all behave as in any terminal.
handle("term:start", ({ cwd, cols, rows }) => {
  const id = nextTerminalId++;
  const shellExe = settings.terminalShell || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash");
  const term = pty.spawn(shellExe, [], {
    name: "xterm-256color", cols: cols || 80, rows: rows || 24,
    cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath("home"),
    env: { ...process.env, TERM_PROGRAM: "JaniX" },
  });
  terminals.set(id, term);
  term.onData((data) => win && !win.isDestroyed() && win.webContents.send("term:data", id, data));
  term.onExit(({ exitCode }) => { terminals.delete(id); win && !win.isDestroyed() && win.webContents.send("term:exit", id, exitCode); });
  return { id, shell: path.basename(shellExe) };
});
handle("term:write", (id, data) => { terminals.get(id)?.write(data); return true; });
handle("term:resize", (id, cols, rows) => { if (cols > 0 && rows > 0) terminals.get(id)?.resize(cols, rows); return true; });
handle("term:kill", (id) => { const t = terminals.get(id); if (t) { t.kill(); terminals.delete(id); } return true; });

// ------------------------------------------------------------------ git
// Branch and per-file status for the explorer colours. Null when the folder
// is not a repository or git is not installed.
function git(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}
handle("git:status", async (root) => {
  const top = await git(["rev-parse", "--show-toplevel"], root);
  if (top === null) return null;
  const repo = path.resolve(top.trim());
  // Git reports long paths; map them onto the folder as JaniX opened it (which may
  // use a short 8.3 name such as CNRS-U~1) so they match the explorer rows.
  const rootReal = fs.realpathSync.native(root);
  const asOpened = (p) => path.join(root, path.relative(rootReal, p));
  const out = await git(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], root);
  if (out === null) return null;
  const files = {};
  let branch = "";
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith("## ")) { branch = entry.slice(3).split("...")[0].replace(/^No commits yet on /, ""); continue; }
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++;            // renames carry the old path as the next entry
    const status = code === "??" ? "untracked" : code.includes("U") ? "conflict" : code.includes("D") ? "deleted"
      : code.includes("A") ? "added" : "modified";
    files[asOpened(path.join(repo, file))] = status;
  }
  return { branch, files };
});

// ------------------------------------------------------------------ menu
function send(command, ...args) { win?.webContents.send("menu", command, ...args); }

// Shortcuts the editor already handles are shown in the menu but not captured
// by it (registerAccelerator: false), so they keep working in the editor.
const shown = (accelerator) => ({ accelerator, registerAccelerator: false });

function buildMenu() {
  const recentFiles = settings.recentFiles.length
    ? settings.recentFiles.map((f) => ({ label: f, click: () => send("openFile", f) }))
    : [{ label: "No recent files", enabled: false }];
  const recentFolders = settings.recentFolders.length
    ? settings.recentFolders.map((f) => ({ label: f, click: () => send("openFolder", f) }))
    : [{ label: "No recent folders", enabled: false }];
  const theme = (id, label) => ({ label, type: "radio", checked: settings.theme === id, click: () => send("setTheme", id) });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "&File", submenu: [
      { label: "New File", accelerator: "CmdOrCtrl+N", click: () => send("newFile") },
      { type: "separator" },
      { label: "Open File…", accelerator: "CmdOrCtrl+O", click: () => send("openFileDialog") },
      { label: "Open Folder…", accelerator: "CmdOrCtrl+Alt+O", click: () => send("openFolderDialog") },
      { label: "Open Recent File", submenu: recentFiles },
      { label: "Open Recent Folder", submenu: recentFolders },
      { type: "separator" },
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => send("saveAs") },
      { label: "Save All", accelerator: "CmdOrCtrl+Alt+S", click: () => send("saveAll") },
      { type: "separator" },
      { label: "Close Editor", accelerator: "CmdOrCtrl+W", click: () => send("closeTab") },
      { type: "separator" },
      { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => send("openSettings") },
      { label: "Close Folder", click: () => send("closeFolder") },
      { type: "separator" },
      { label: "Exit", role: "quit" },
    ] },
    { label: "&Edit", submenu: [
      { label: "Undo", ...shown("CmdOrCtrl+Z"), click: () => send("editor", "undo") },
      { label: "Redo", ...shown("CmdOrCtrl+Y"), click: () => send("editor", "redo") },
      { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { type: "separator" },
      { label: "Find", ...shown("CmdOrCtrl+F"), click: () => send("editor", "actions.find") },
      { label: "Replace", ...shown("CmdOrCtrl+H"), click: () => send("editor", "editor.action.startFindReplaceAction") },
      { label: "Find in Files", accelerator: "CmdOrCtrl+Shift+F", click: () => send("showSearch") },
      { type: "separator" },
      { label: "Toggle Line Comment", ...shown("CmdOrCtrl+/"), click: () => send("editor", "editor.action.commentLine") },
      { label: "Format Document", ...shown("Shift+Alt+F"), click: () => send("editor", "editor.action.formatDocument") },
    ] },
    { label: "&Selection", submenu: [
      { label: "Select All", ...shown("CmdOrCtrl+A"), click: () => send("editor", "editor.action.selectAll") },
      { label: "Add Cursor Above", ...shown("CmdOrCtrl+Alt+Up"), click: () => send("editor", "editor.action.insertCursorAbove") },
      { label: "Add Cursor Below", ...shown("CmdOrCtrl+Alt+Down"), click: () => send("editor", "editor.action.insertCursorBelow") },
      { label: "Add Next Occurrence", ...shown("CmdOrCtrl+D"), click: () => send("editor", "editor.action.addSelectionToNextFindMatch") },
      { label: "Copy Line Down", ...shown("Shift+Alt+Down"), click: () => send("editor", "editor.action.copyLinesDownAction") },
      { label: "Move Line Up", ...shown("Alt+Up"), click: () => send("editor", "editor.action.moveLinesUpAction") },
      { label: "Move Line Down", ...shown("Alt+Down"), click: () => send("editor", "editor.action.moveLinesDownAction") },
    ] },
    { label: "&View", submenu: [
      { label: "Command Palette…", accelerator: "CmdOrCtrl+Shift+P", click: () => send("editor", "editor.action.quickCommand") },
      { label: "Go to File…", accelerator: "CmdOrCtrl+P", click: () => send("quickOpen") },
      { label: "Go to Line…", ...shown("CmdOrCtrl+G"), click: () => send("editor", "editor.action.gotoLine") },
      { type: "separator" },
      { label: "Split Editor", accelerator: "CmdOrCtrl+\\", click: () => send("toggleSplit") },
      { label: "Open Markdown Preview to the Side", accelerator: "CmdOrCtrl+Shift+V", click: () => send("markdownPreview") },
      { type: "separator" },
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: () => send("toggleSidebar") },
      { label: "Toggle Terminal", accelerator: "CmdOrCtrl+`", click: () => send("toggleTerminal") },
      { label: "New Terminal", accelerator: "CmdOrCtrl+Shift+`", click: () => send("newTerminal") },
      { label: "Toggle Word Wrap", accelerator: "Alt+Z", click: () => send("toggleWordWrap") },
      { label: "Toggle Minimap", click: () => send("toggleMinimap") },
      { type: "separator" },
      { label: "Theme", submenu: [theme("janix-dark", "JaniX Dark"), theme("janix-light", "JaniX Light"), theme("hc-black", "High Contrast")] },
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => send("zoom", 1) },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => send("zoom", -1) },
      { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", click: () => send("zoom", 0) },
      { type: "separator" },
      { label: "Toggle Full Screen", role: "togglefullscreen" },
      { label: "Developer Tools", role: "toggleDevTools" },
    ] },
    { label: "&Help", submenu: [
      { label: "About JaniX", click: () => send("about") },
      { type: "separator" },
      { label: "Study with Janin (YouTube)", click: () => shell.openExternal("https://www.youtube.com/@studywithjanin") },
      { label: "Pomodoro Study with Janin (YouTube)", click: () => shell.openExternal("https://www.youtube.com/@pomodorostudywithjanin3326") },
    ] },
  ]));
}

// ------------------------------------------------------------------ window
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 640, minHeight: 400,
    title: "JaniX", backgroundColor: "#16181d", show: false,
    icon: path.join(APP_ROOT, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL("app://janix/src/renderer/index.html");

  // Links open in the default browser, never inside the editor window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  win.on("close", (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send("app:request-close");
  });
  win.on("closed", () => { for (const t of terminals.values()) t.kill(); terminals.clear(); win = null; });
}

// A file passed on the command line (e.g. "Open with JaniX") opens on start-up.
function fileFromArgs(argv) {
  const candidate = argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith("-") && fs.existsSync(a));
  return candidate ? path.resolve(candidate) : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const target = fileFromArgs(argv);
    if (target) send(fs.statSync(target).isDirectory() ? "openFolder" : "openFile", target);
  });

  app.whenReady().then(() => {
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const file = path.normalize(path.join(APP_ROOT, decodeURIComponent(pathname)));
      if (!file.startsWith(APP_ROOT)) return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    settings = loadSettings();
    buildMenu();
    handle("app:launchTarget", () => {
      const target = fileFromArgs(process.argv);
      return target ? { path: target, isDir: fs.statSync(target).isDirectory() } : null;
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
