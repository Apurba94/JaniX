// JaniX editor UI: tabs, explorer, quick open, search, terminals, split editor,
// markdown preview, git status and settings around Monaco editors that swap one
// model per open file.
"use strict";

const api = window.janix;
const $ = (id) => document.getElementById(id);
const SEP = api.pathSep;

const state = {
  settings: null,
  root: null,                 // open folder
  tabs: [],                   // { id, path, title, model, viewStates: [left, right], savedVersion }
  expanded: new Set(),        // expanded folders in the tree
  selectedPath: null,
  fileIndex: null,            // cached file list for quick open
  untitledCount: 0,
  searchCase: false,
  git: null,                  // { branch, files: { lowercased path: status } }
  terms: [],                  // { id, term, fit, el, title, exited }
  activeTerm: null,
};
let monaco = null;
let nextTabId = 1;

// Two editor panes. The right pane shows a second editor or a markdown preview.
const panes = [
  { el: () => $("pane-left"), host: () => $("editor"), editor: null, tabId: null },
  { el: () => $("pane-right"), host: () => $("editor2"), editor: null, tabId: null },
];
let focusedPane = 0;
let editor = null;            // the focused pane's editor
let rightMode = null;         // null | "editor" | "preview"
let previewTabId = null;

// ------------------------------------------------------------------ helpers
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");
const join = (...parts) => parts.join(SEP).replace(/[\\/]+/g, SEP);
const samePath = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

async function guard(fn) {
  try { return await fn(); }
  catch (error) { toast(error.message, true); return undefined; }
}

// File-type badge for the explorer and tabs: a short label in a language colour.
const ICONS = {
  js: ["JS", "#e8c547"], mjs: ["JS", "#e8c547"], cjs: ["JS", "#e8c547"], jsx: ["JSX", "#61dafb"],
  ts: ["TS", "#3d8fd6"], tsx: ["TSX", "#3d8fd6"], json: ["{}", "#e8c547"], html: ["<>", "#e8743b"],
  css: ["#", "#5aa4e8"], scss: ["#", "#cd6799"], md: ["M", "#7aa2f7"], py: ["PY", "#4b8bbe"],
  java: ["J", "#e76f00"], kt: ["K", "#a97bff"], c: ["C", "#5c8dbc"], h: ["H", "#5c8dbc"], cpp: ["C++", "#5c8dbc"],
  cs: ["C#", "#68217a"], go: ["GO", "#00add8"], rs: ["RS", "#dea584"], php: ["PHP", "#8892bf"], rb: ["RB", "#cc342d"],
  sql: ["SQL", "#e38c00"], sh: ["$", "#89e051"], ps1: ["PS", "#3c87c8"], bat: ["BAT", "#c1f12e"], yml: ["Y", "#cb171e"],
  yaml: ["Y", "#cb171e"], xml: ["<>", "#8a8a8a"], svg: ["SVG", "#ffb13b"], txt: ["≡", "#9aa0a6"], dart: ["D", "#0175c2"],
  swift: ["SW", "#f05138"], lua: ["LUA", "#000080"], r: ["R", "#276dc3"], vue: ["V", "#41b883"], env: ["ENV", "#ecd53f"],
};
function iconFor(name, isDir) {
  if (isDir) return ["", ""];
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return ICONS[ext] || ["•", "#8a909c"];
}

// ------------------------------------------------------------------ Monaco
function loadMonaco() {
  return new Promise((resolve) => {
    window.require.config({ paths: { vs: "../../node_modules/monaco-editor/min/vs" } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco));
  });
}

function defineThemes() {
  monaco.editor.defineTheme("janix-dark", {
    base: "vs-dark", inherit: true,
    rules: [
      { token: "comment", foreground: "6a7385", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" }, { token: "string", foreground: "a5d6a7" },
      { token: "number", foreground: "f78c6c" }, { token: "type", foreground: "36c6c0" },
    ],
    colors: {
      "editor.background": "#16181d", "editor.lineHighlightBackground": "#1f232b", "editorLineNumber.foreground": "#4b5262",
      "editorLineNumber.activeForeground": "#c7cbd3", "editorCursor.foreground": "#36c6c0", "editor.selectionBackground": "#2c3a52",
      "editorIndentGuide.background1": "#262a33", "editorWidget.background": "#1f232b", "minimap.background": "#16181d",
    },
  });
  monaco.editor.defineTheme("janix-light", {
    base: "vs", inherit: true, rules: [{ token: "comment", foreground: "7a8394", fontStyle: "italic" }],
    colors: { "editor.background": "#ffffff", "editorCursor.foreground": "#128c87", "editor.lineHighlightBackground": "#f3f5f8" },
  });
}

function editorOptions() {
  const s = state.settings;
  return {
    fontSize: s.fontSize, fontFamily: s.fontFamily, wordWrap: s.wordWrap, minimap: { enabled: s.minimap }, tabSize: s.tabSize,
    lineNumbers: s.lineNumbers, renderWhitespace: s.renderWhitespace, cursorStyle: s.cursorStyle, fontLigatures: true,
    smoothScrolling: true, cursorBlinking: "smooth", cursorSmoothCaretAnimation: "on",
    bracketPairColorization: { enabled: true }, guides: { bracketPairs: true },
    automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 8 }, mouseWheelZoom: true,
    stickyScroll: { enabled: true }, linkedEditing: true, formatOnPaste: false,
  };
}

function createEditor(paneIndex) {
  const pane = panes[paneIndex];
  const e = monaco.editor.create(pane.host(), { model: null, theme: state.settings.theme, ...editorOptions() });
  pane.editor = e;
  e.onDidFocusEditorWidget(() => focusPane(paneIndex));
  e.onDidChangeCursorPosition(() => { if (e === editor) updateStatus(); });
  e.onDidChangeCursorSelection(() => { if (e === editor) updateStatus(); });
  e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => runCommand("save"));
  return e;
}

function focusPane(index) {
  if (index === 1 && rightMode !== "editor") index = 0;
  if (focusedPane === index && editor === panes[index].editor) return;
  focusedPane = index;
  editor = panes[index].editor;
  panes[0].el().classList.toggle("focused-pane", rightMode === "editor" && index === 0);
  panes[1].el().classList.toggle("focused-pane", rightMode === "editor" && index === 1);
  const tab = activeTab();
  state.selectedPath = tab?.path || state.selectedPath;
  markSelectedInTree();
  renderTabs();
  updateStatus();
}

// ------------------------------------------------------------------ settings
async function updateSettings(patch) {
  Object.assign(state.settings, patch);
  await guard(() => api.settings.set(patch));
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  monaco.editor.setTheme(theme);
  for (const t of state.terms) t.term.options.theme = terminalTheme();
}

function applyEditorSettings() {
  for (const pane of panes) pane.editor?.updateOptions(editorOptions());
  for (const tab of state.tabs) tab.model.updateOptions({ tabSize: Number(state.settings.tabSize) });
  for (const t of state.terms) { t.term.options.fontSize = Number(state.settings.terminalFontSize); t.fit.fit(); }
  updateStatus();
}

// ------------------------------------------------------------------ tabs
const tabById = (id) => state.tabs.find((t) => t.id === id) || null;
const activeTab = () => tabById(panes[focusedPane].tabId);
const isDirty = (tab) => tab.model.getAlternativeVersionId() !== tab.savedVersion;

function renderTabs() {
  const bar = $("tabs");
  bar.textContent = "";
  const otherPane = rightMode === "editor" ? panes[1 - focusedPane].tabId : null;
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === panes[focusedPane].tabId ? " active" : "") + (isDirty(tab) ? " dirty" : "")
      + (tab.id === otherPane ? " in-other-pane" : "");
    el.title = tab.path || tab.title;
    el.setAttribute("role", "tab");
    const [badge, color] = iconFor(tab.title, false);
    el.innerHTML = `<span class="icon" style="color:${color};font-size:10px;font-weight:800">${escapeHtml(badge)}</span>
      <span class="tab-label">${escapeHtml(tab.title)}</span><button class="tab-close" title="Close (Ctrl+W)"><span>✕</span></button>`;
    el.addEventListener("mousedown", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    el.addEventListener("click", (e) => { if (e.target.closest(".tab-close")) closeTab(tab.id); else activateTab(tab.id); });
    bar.appendChild(el);
    if (tab.id === panes[focusedPane].tabId) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  $("welcome").hidden = state.tabs.length > 0;
  if (rightMode === "editor") $("pane-right-title").textContent = tabById(panes[1].tabId)?.title || "";
  updateTitle();
}

function updateTitle() {
  const tab = activeTab();
  const parts = [];
  if (tab) parts.push((isDirty(tab) ? "● " : "") + tab.title);
  if (state.root) parts.push(basename(state.root));
  parts.push("JaniX");
  document.title = parts.join(" — ");
}

// Show a tab in a pane (the focused one unless given).
function activateTab(id, paneIndex = focusedPane) {
  const pane = panes[paneIndex];
  const e = pane.editor;
  const current = tabById(pane.tabId);
  if (current && e) current.viewStates[paneIndex] = e.saveViewState();
  pane.tabId = id;
  const tab = tabById(id);
  if (tab) {
    e.setModel(tab.model);
    if (tab.viewStates[paneIndex]) e.restoreViewState(tab.viewStates[paneIndex]);
    if (paneIndex === focusedPane) {
      e.focus();
      state.selectedPath = tab.path;
      markSelectedInTree();
    }
  } else {
    e.setModel(null);
  }
  renderTabs();
  updateStatus();
  saveSession();
}

function newTab(model, path, title) {
  const tab = { id: nextTabId++, path, title, model, viewStates: [null, null], savedVersion: model.getAlternativeVersionId() };
  model.updateOptions({ tabSize: Number(state.settings.tabSize) });
  attachModelListeners(tab);
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

const autoSaveSoon = debounce((tab) => { if (state.tabs.includes(tab) && tab.path && isDirty(tab)) saveTab(tab); }, 1000);
const renderPreviewSoon = debounce(() => renderPreview(), 150);

function attachModelListeners(tab) {
  tab.model.onDidChangeContent(() => {
    renderTabs();
    if (state.settings.autoSave === "afterDelay" && tab.path) autoSaveSoon(tab);
    if (rightMode === "preview" && previewTabId === tab.id) renderPreviewSoon();
  });
}

async function openFile(path, { line, column } = {}) {
  const existing = state.tabs.find((t) => samePath(t.path, path));
  if (existing) {
    activateTab(existing.id);
  } else {
    const text = await guard(() => api.fs.readFile(path));
    if (text === undefined) return;
    const uri = monaco.Uri.file(path);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, undefined, uri);
    newTab(model, path, basename(path));
  }
  if (line) {
    editor.setPosition({ lineNumber: line, column: column || 1 });
    editor.revealLineInCenter(line);
    editor.focus();
  }
}

function newUntitled() {
  state.untitledCount += 1;
  const title = `Untitled-${state.untitledCount}`;
  const model = monaco.editor.createModel("", "plaintext", monaco.Uri.parse(`untitled:${title}`));
  newTab(model, null, title);
}

// Swap a tab's model for one at a new path (after Save As or rename), keeping its text.
function retargetTab(tab, newPath, { keepDirty = false } = {}) {
  const text = tab.model.getValue();
  const old = tab.model;
  tab.model = monaco.editor.getModel(monaco.Uri.file(newPath)) || monaco.editor.createModel(text, undefined, monaco.Uri.file(newPath));
  tab.model.updateOptions({ tabSize: Number(state.settings.tabSize) });
  attachModelListeners(tab);
  tab.path = newPath;
  tab.title = basename(newPath);
  tab.savedVersion = keepDirty ? -1 : tab.model.getAlternativeVersionId();
  panes.forEach((pane) => { if (pane.tabId === tab.id && pane.editor) pane.editor.setModel(tab.model); });
  old.dispose();
}

async function saveTab(tab, { saveAs = false } = {}) {
  if (!tab) return false;
  let target = tab.path;
  if (!target || saveAs) {
    const suggested = tab.path || (state.root ? join(state.root, tab.title) : tab.title);
    target = await guard(() => api.dialog.saveAs(suggested));
    if (!target) return false;
  }
  const ok = await guard(() => api.fs.writeFile(target, tab.model.getValue()));
  if (!ok) return false;
  if (!samePath(target, tab.path)) {
    retargetTab(tab, target);
    state.fileIndex = null;
    if (state.root && target.toLowerCase().startsWith(state.root.toLowerCase())) refreshTree();
  }
  tab.savedVersion = tab.model.getAlternativeVersionId();
  renderTabs();
  updateStatus();
  saveSession();
  refreshGitSoon();
  return true;
}

async function saveAll({ onlyWithPath = false } = {}) {
  for (const tab of state.tabs.filter(isDirty)) {
    if (onlyWithPath && !tab.path) continue;
    if (!(await saveTab(tab))) return false;
  }
  return true;
}

async function closeTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  if (isDirty(tab)) {
    const choice = await guard(() => api.dialog.confirm({
      message: `Do you want to save the changes you made to ${tab.title}?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ["Save", "Don't Save", "Cancel"],
    }));
    if (choice === 2 || choice === undefined) return;
    if (choice === 0 && !(await saveTab(tab))) return;
  }
  const index = state.tabs.indexOf(tab);
  state.tabs.splice(index, 1);
  if (previewTabId === id) closeRightPane();
  const next = state.tabs[Math.min(index, state.tabs.length - 1)] || null;
  panes.forEach((pane, i) => { if (pane.tabId === id) activateTab(next ? next.id : null, i); });
  if (rightMode === "editor" && !panes[1].tabId) closeRightPane();
  tab.model.dispose();
  renderTabs();
  saveSession();
}

function cycleTabs(step) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === panes[focusedPane].tabId);
  activateTab(state.tabs[(i + step + state.tabs.length) % state.tabs.length].id);
}

function saveSession() {
  const files = state.tabs.filter((t) => t.path).map((t) => t.path);
  const active = activeTab()?.path || null;
  api.settings.set({ session: { root: state.root, files, active } }).catch(() => {});
}

// ------------------------------------------------------------------ split editor and markdown preview
function openRightPane(mode) {
  rightMode = mode;
  $("pane-right").hidden = false;
  $("editor2").hidden = mode !== "editor";
  $("preview").hidden = mode !== "preview";
  if (mode === "editor" && !panes[1].editor) createEditor(1);
}

function closeRightPane() {
  if (!rightMode) return;
  if (panes[1].editor) { panes[1].editor.setModel(null); panes[1].tabId = null; }
  rightMode = null;
  previewTabId = null;
  $("pane-right").hidden = true;
  panes[0].el().classList.remove("focused-pane");
  focusPane(0);
  panes[0].editor.focus();
  renderTabs();
}

function toggleSplit() {
  if (rightMode === "editor") return closeRightPane();
  const tab = activeTab();
  if (!tab) return toast("Open a file first, then split the editor.");
  openRightPane("editor");
  activateTab(tab.id, 1);
  focusPane(1);
  panes[1].editor.focus();
}

function markdownPreview() {
  const tab = activeTab();
  if (!tab || tab.model.getLanguageId() !== "markdown") return toast("Open a Markdown (.md) file to preview it.");
  if (rightMode === "editor") closeRightPane();
  openRightPane("preview");
  previewTabId = tab.id;
  renderPreview();
}

function renderPreview() {
  const tab = tabById(previewTabId);
  if (!tab || rightMode !== "preview") return;
  $("pane-right-title").textContent = `Preview: ${tab.title}`;
  const html = window.marked.parse(tab.model.getValue(), { gfm: true, breaks: false });
  const article = $("preview");
  const scroll = article.scrollTop;
  article.innerHTML = window.DOMPurify.sanitize(html);
  // Colour fenced code blocks with Monaco's own highlighter.
  for (const code of article.querySelectorAll("pre code[class*='language-']")) {
    const lang = code.className.match(/language-([\w+#-]+)/)?.[1];
    const known = monaco.languages.getLanguages().find((l) => l.id === lang || l.aliases?.some((a) => a.toLowerCase() === lang));
    if (known) { code.setAttribute("data-lang", known.id); monaco.editor.colorizeElement(code, {}); }
  }
  article.scrollTop = scroll;
}

$("pane-right-close").addEventListener("click", closeRightPane);
$("preview").addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (!link) return;
  e.preventDefault();
  if (/^https?:/.test(link.href)) window.open(link.href);
});

// ------------------------------------------------------------------ explorer
async function openFolder(dir) {
  state.root = dir;
  state.expanded = new Set([dir]);
  state.fileIndex = null;
  state.git = null;
  $("folder-name").textContent = basename(dir);
  $("folder-name").title = dir;
  $("status-folder").textContent = basename(dir);
  $("no-folder").hidden = true;
  await updateSettings({ lastFolder: dir });
  await refreshTree();
  refreshGit();
  updateTitle();
  saveSession();
}

function closeFolder() {
  state.root = null;
  state.fileIndex = null;
  state.git = null;
  $("tree").textContent = "";
  $("folder-name").textContent = "";
  $("status-folder").textContent = "";
  $("status-branch").textContent = "";
  $("no-folder").hidden = false;
  updateSettings({ lastFolder: null });
  updateTitle();
  saveSession();
}

async function refreshTree() {
  if (!state.root) return;
  const tree = $("tree");
  const fragment = document.createDocumentFragment();
  await renderDir(state.root, 0, fragment);
  tree.textContent = "";
  tree.appendChild(fragment);
  markSelectedInTree();
  decorateGit();
}

async function renderDir(dir, depth, parent) {
  const entries = await guard(() => api.fs.readDir(dir));
  if (!entries) return;
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "node";
    row.dataset.path = entry.path;
    row.dataset.dir = entry.isDir ? "1" : "";
    row.setAttribute("role", "treeitem");
    row.style.paddingLeft = `${10 + depth * 12}px`;
    const open = entry.isDir && state.expanded.has(entry.path);
    const [badge, color] = iconFor(entry.name, entry.isDir);
    row.innerHTML = `<span class="twisty">${entry.isDir ? (open ? "▾" : "▸") : ""}</span>` +
      (entry.isDir ? "" : `<span class="icon" style="color:${color}">${escapeHtml(badge)}</span>`) +
      `<span class="label">${escapeHtml(entry.name)}</span><span class="git-badge"></span>`;
    parent.appendChild(row);
    if (open) await renderDir(entry.path, depth + 1, parent);
  }
}

function markSelectedInTree() {
  for (const el of document.querySelectorAll(".node.selected")) el.classList.remove("selected");
  if (!state.selectedPath) return;
  for (const el of document.querySelectorAll(".node")) {
    if (samePath(el.dataset.path, state.selectedPath)) { el.classList.add("selected"); break; }
  }
}

$("tree").addEventListener("click", async (e) => {
  const row = e.target.closest(".node");
  if (!row || row.querySelector("input")) return;
  state.selectedPath = row.dataset.path;
  if (row.dataset.dir) {
    if (state.expanded.has(row.dataset.path)) state.expanded.delete(row.dataset.path);
    else state.expanded.add(row.dataset.path);
    await refreshTree();
  } else {
    markSelectedInTree();
    openFile(row.dataset.path);
  }
});

$("tree").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const row = e.target.closest(".node");
  if (!state.root) return;
  const target = row ? row.dataset.path : state.root;
  const isDir = row ? Boolean(row.dataset.dir) : true;
  if (row) { state.selectedPath = target; markSelectedInTree(); }
  const folder = isDir ? target : dirname(target);
  const items = [
    ["New File…", () => createEntry(folder, false)],
    ["New Folder…", () => createEntry(folder, true)],
  ];
  if (row) {
    items.push(null,
      ["Rename…", () => renameEntry(row)],
      ["Delete (to Recycle Bin)", () => deleteEntry(target)],
      null,
      ["Open in Integrated Terminal", () => newTerminal(isDir ? target : dirname(target))],
      ["Copy Path", () => navigator.clipboard.writeText(target)],
      ["Reveal in File Explorer", () => api.fs.reveal(target)]);
  }
  showContextMenu(e.clientX, e.clientY, items);
});

function showContextMenu(x, y, items) {
  const menu = $("contextmenu");
  menu.textContent = "";
  for (const item of items) {
    if (!item) { menu.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.textContent = item[0];
    b.addEventListener("click", () => { menu.hidden = true; item[1](); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
}
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#contextmenu")) $("contextmenu").hidden = true; });

// Inline name input inside the tree (window.prompt is not available in Electron).
function askName(anchorRow, depthPx, initial) {
  return new Promise((resolve) => {
    const row = document.createElement("div");
    row.className = "node";
    row.style.paddingLeft = depthPx;
    const input = document.createElement("input");
    input.value = initial || "";
    row.innerHTML = `<span class="twisty"></span>`;
    row.appendChild(input);
    if (anchorRow) anchorRow.after(row); else $("tree").prepend(row);
    input.focus();
    if (initial) input.setSelectionRange(0, initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length);
    let done = false;
    const finish = (value) => { if (done) return; done = true; row.remove(); resolve(value && value.trim() ? value.trim() : null); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
      if (e.key === "Escape") finish(null);
    });
    input.addEventListener("blur", () => finish(input.value));
  });
}

function rowFor(path) {
  return [...document.querySelectorAll(".node")].find((el) => samePath(el.dataset.path, path)) || null;
}

async function createEntry(folder, isDir) {
  if (!state.root) return;
  if (!samePath(folder, state.root) && !state.expanded.has(folder)) { state.expanded.add(folder); await refreshTree(); }
  const anchor = rowFor(folder);
  const depth = anchor ? `${parseInt(anchor.style.paddingLeft, 10) + 12}px` : "10px";
  const name = await askName(anchor, depth, "");
  if (!name) return;
  if (/[<>:"|?*]/.test(name)) { toast(`"${name}" contains characters Windows does not allow in names.`, true); return; }
  const target = join(folder, name);
  const ok = await guard(() => (isDir ? api.fs.createFolder(target) : api.fs.createFile(target)));
  if (!ok) return;
  state.fileIndex = null;
  if (isDir) state.expanded.add(target);
  await refreshTree();
  refreshGitSoon();
  if (!isDir) openFile(target);
}

async function renameEntry(row) {
  const from = row.dataset.path;
  const label = row.querySelector(".label");
  row.hidden = true;
  const name = await askName(row, row.style.paddingLeft, label.textContent);
  row.hidden = false;
  if (!name || name === basename(from)) return;
  const to = join(dirname(from), name);
  if (!(await guard(() => api.fs.rename(from, to)))) return;
  for (const tab of state.tabs) {
    if (tab.path && (samePath(tab.path, from) || tab.path.toLowerCase().startsWith(from.toLowerCase() + SEP))) {
      retargetTab(tab, to + tab.path.slice(from.length), { keepDirty: isDirty(tab) });
    }
  }
  state.fileIndex = null;
  await refreshTree();
  refreshGitSoon();
  renderTabs();
}

async function deleteEntry(target) {
  const choice = await guard(() => api.dialog.confirm({
    message: `Move '${basename(target)}' to the Recycle Bin?`,
    detail: "You can restore it from the Recycle Bin.",
    buttons: ["Move to Recycle Bin", "Cancel"],
  }));
  if (choice !== 0) return;
  if (!(await guard(() => api.fs.trash(target)))) return;
  for (const tab of [...state.tabs]) {
    if (tab.path && (samePath(tab.path, target) || tab.path.toLowerCase().startsWith(target.toLowerCase() + SEP))) {
      tab.savedVersion = tab.model.getAlternativeVersionId();
      await closeTab(tab.id);
    }
  }
  state.fileIndex = null;
  await refreshTree();
  refreshGitSoon();
}

document.querySelectorAll("#explorer-view .view-actions button").forEach((b) => b.addEventListener("click", () => {
  const action = b.dataset.action;
  const selected = state.selectedPath;
  const folder = selected && rowFor(selected)?.dataset.dir ? selected : selected ? dirname(selected) : state.root;
  if (action === "newFile") createEntry(folder || state.root, false);
  if (action === "newFolder") createEntry(folder || state.root, true);
  if (action === "refresh") { state.fileIndex = null; refreshTree(); refreshGit(); }
  if (action === "collapse") { state.expanded = new Set([state.root]); refreshTree(); }
}));

// ------------------------------------------------------------------ git status
async function refreshGit() {
  if (!state.root) return;
  const root = state.root;
  const result = await api.git.status(root).catch(() => null);
  if (root !== state.root) return;
  state.git = result ? { branch: result.branch, files: Object.fromEntries(Object.entries(result.files).map(([p, s]) => [p.toLowerCase(), s])) } : null;
  $("status-branch").textContent = state.git?.branch || "";
  decorateGit();
}
const refreshGitSoon = debounce(refreshGit, 400);

const GIT_LETTER = { modified: "M", untracked: "U", added: "A", deleted: "D", conflict: "!" };
function decorateGit() {
  const files = state.git?.files || {};
  const changed = Object.keys(files);
  for (const row of document.querySelectorAll("#tree .node")) {
    row.classList.remove("git-modified", "git-untracked", "git-added", "git-deleted", "git-conflict", "git-folder");
    const badge = row.querySelector(".git-badge");
    if (badge) badge.textContent = "";
    if (!changed.length) continue;
    const p = row.dataset.path.toLowerCase();
    if (row.dataset.dir) {
      if (changed.some((f) => f.startsWith(p + SEP))) row.classList.add("git-folder");
    } else if (files[p]) {
      row.classList.add(`git-${files[p]}`);
      if (badge) badge.textContent = GIT_LETTER[files[p]];
      row.title = { modified: "Modified", untracked: "Untracked", added: "Added", deleted: "Deleted", conflict: "Merge conflict" }[files[p]];
    }
  }
}

// ------------------------------------------------------------------ quick open (Ctrl+P)
function fuzzyScore(query, text) {
  // Every query character must appear in order; consecutive and word-start matches score higher.
  let score = 0, qi = 0, last = -2;
  const lower = text.toLowerCase();
  const positions = [];
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] === query[qi]) {
      score += (i === last + 1 ? 5 : 1) + (i === 0 || /[\\/._\- ]/.test(text[i - 1]) ? 3 : 0);
      positions.push(i);
      last = i;
      qi++;
    }
  }
  return qi === query.length ? { score: score - text.length * 0.01, positions } : null;
}

let quickItems = [];
let quickIndex = 0;
let quickMode = "files";

async function showQuickOpen(mode = "files") {
  quickMode = mode;
  $("quickopen").hidden = false;
  const input = $("quickopen-input");
  input.value = "";
  input.placeholder = mode === "files"
    ? (state.root ? "Search files by name" : "Open a folder to search its files")
    : "Select language mode";
  input.focus();
  if (mode === "files" && state.root && !state.fileIndex) state.fileIndex = (await guard(() => api.fs.listFiles(state.root))) || [];
  updateQuickOpen();
}

function hideQuickOpen() { $("quickopen").hidden = true; editor?.focus(); }

function updateQuickOpen() {
  const query = $("quickopen-input").value.trim().toLowerCase();
  const list = $("quickopen-list");
  if (quickMode === "files") {
    const files = state.fileIndex || [];
    const recent = state.tabs.filter((t) => t.path && state.root).map((t) => t.path.slice(state.root.length + 1));
    const source = query ? files : [...new Set([...recent, ...files])];
    quickItems = source
      .map((rel) => {
        const name = basename(rel);
        const m = query ? fuzzyScore(query, name) || fuzzyScore(query, rel) : { score: 0, positions: [] };
        return m && { rel, name, score: m.score + (fuzzyScore(query, name) ? 10 : 0), positions: fuzzyScore(query, name)?.positions || [] };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  } else {
    quickItems = monaco.languages.getLanguages()
      .map((l) => ({ id: l.id, name: l.aliases?.[0] || l.id }))
      .filter((l) => !query || l.name.toLowerCase().includes(query) || l.id.includes(query))
      .slice(0, 80);
  }
  quickIndex = 0;
  list.textContent = "";
  quickItems.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "qo-item" + (i === 0 ? " active" : "");
    if (quickMode === "files") {
      const name = [...item.name].map((ch, k) => (item.positions.includes(k) ? `<b>${escapeHtml(ch)}</b>` : escapeHtml(ch))).join("");
      const dir = item.rel.length > item.name.length ? item.rel.slice(0, -item.name.length - 1) : "";
      el.innerHTML = `<span class="qo-name">${name}</span><span class="qo-dir">${escapeHtml(dir)}</span>`;
    } else {
      el.innerHTML = `<span class="qo-name">${escapeHtml(item.name)}</span><span class="qo-dir">${escapeHtml(item.id)}</span>`;
    }
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pickQuick(i); });
    list.appendChild(el);
  });
  if (!quickItems.length) list.innerHTML = `<div class="qo-item"><span class="qo-dir">${quickMode === "files" && !state.root ? "No folder is open." : "No matches."}</span></div>`;
}

function pickQuick(i) {
  const item = quickItems[i];
  hideQuickOpen();
  if (!item) return;
  if (quickMode === "files") openFile(join(state.root, item.rel));
  else if (editor.getModel()) { monaco.editor.setModelLanguage(editor.getModel(), item.id); updateStatus(); }
}

$("quickopen-input").addEventListener("input", updateQuickOpen);
$("quickopen-input").addEventListener("keydown", (e) => {
  const items = $("quickopen-list").children;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[quickIndex]?.classList.remove("active");
    quickIndex = (quickIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(items.length, 1);
    items[quickIndex]?.classList.add("active");
    items[quickIndex]?.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "Enter") { e.preventDefault(); pickQuick(quickIndex); }
  if (e.key === "Escape") hideQuickOpen();
});
$("quickopen").addEventListener("mousedown", (e) => { if (e.target === $("quickopen")) hideQuickOpen(); });

// ------------------------------------------------------------------ search in files
async function runSearch() {
  const query = $("search-input").value;
  const out = $("search-results");
  out.textContent = "";
  if (!query) { $("search-summary").textContent = ""; return; }
  if (!state.root) { $("search-summary").textContent = "Open a folder to search in its files."; return; }
  $("search-summary").textContent = "Searching…";
  const results = (await guard(() => api.fs.search(state.root, query, { caseSensitive: state.searchCase }))) || [];
  const byFile = new Map();
  for (const r of results) { if (!byFile.has(r.path)) byFile.set(r.path, []); byFile.get(r.path).push(r); }
  $("search-summary").textContent = results.length
    ? `${results.length}${results.length >= 2000 ? "+" : ""} results in ${byFile.size} files`
    : "No results found.";
  const fragment = document.createDocumentFragment();
  for (const [file, hits] of byFile) {
    const head = document.createElement("div");
    head.className = "result-file";
    head.innerHTML = `${escapeHtml(basename(file))}<small>${escapeHtml(hits[0].rel)}</small>`;
    fragment.appendChild(head);
    for (const hit of hits) {
      const row = document.createElement("div");
      row.className = "result-line";
      const start = hit.column - 1;
      const text = hit.text;
      const trimmed = Math.max(0, start - 30);
      row.innerHTML = `${trimmed ? "…" : ""}${escapeHtml(text.slice(trimmed, start))}<mark>${escapeHtml(text.slice(start, start + query.length))}</mark>${escapeHtml(text.slice(start + query.length))}`;
      row.title = `${hit.rel}:${hit.line}`;
      row.addEventListener("click", () => openFile(file, { line: hit.line, column: hit.column }));
      fragment.appendChild(row);
    }
  }
  out.appendChild(fragment);
}
$("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
$("search-case").addEventListener("click", () => {
  state.searchCase = !state.searchCase;
  $("search-case").classList.toggle("on", state.searchCase);
  runSearch();
});

// ------------------------------------------------------------------ views and layout
function showView(view) {
  if (document.body.classList.contains("sidebar-hidden")) toggleSidebar(true);
  for (const b of document.querySelectorAll(".activity[data-view]")) b.classList.toggle("active", b.dataset.view === view);
  $("explorer-view").hidden = view !== "explorer";
  $("search-view").hidden = view !== "search";
  if (view === "search") { $("search-input").focus(); $("search-input").select(); }
}
document.querySelectorAll(".activity[data-view]").forEach((b) => b.addEventListener("click", () => {
  const visible = !document.body.classList.contains("sidebar-hidden");
  if (visible && b.classList.contains("active")) toggleSidebar(false); else showView(b.dataset.view);
}));

function toggleSidebar(force) {
  const show = force ?? document.body.classList.contains("sidebar-hidden");
  document.body.classList.toggle("sidebar-hidden", !show);
  updateSettings({ sidebarVisible: show });
}

function dragSash(sash, onMove, onDone) {
  sash.addEventListener("mousedown", (e) => {
    e.preventDefault();
    sash.classList.add("dragging");
    const start = { x: e.clientX, y: e.clientY };
    const move = (ev) => onMove(ev.clientX - start.x, ev.clientY - start.y);
    const up = () => {
      sash.classList.remove("dragging");
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      onDone();
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    onMove.begin?.();
  });
}

let sidebarStart = 0;
const sidebarMove = (dx) => { $("sidebar").style.width = `${Math.max(160, Math.min(innerWidth * 0.7, sidebarStart + dx))}px`; };
sidebarMove.begin = () => { sidebarStart = $("sidebar").getBoundingClientRect().width; };
dragSash($("sash"), sidebarMove, () => updateSettings({ sidebarWidth: $("sidebar").getBoundingClientRect().width }));

let panelStart = 0;
const panelMove = (_dx, dy) => { $("panel").style.height = `${Math.max(100, Math.min(innerHeight * 0.8, panelStart - dy))}px`; };
panelMove.begin = () => { panelStart = $("panel").getBoundingClientRect().height; };
dragSash($("panel-sash"), panelMove, () => updateSettings({ panelHeight: $("panel").getBoundingClientRect().height }));

// ------------------------------------------------------------------ terminals (xterm.js on a real pty)
function terminalTheme() {
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  const light = document.body.dataset.theme === "janix-light";
  return {
    background: v("--bg-panel"), foreground: v("--fg"), cursor: v("--accent"), cursorAccent: v("--bg-panel"),
    selectionBackground: light ? "#cfe8e7" : "#2c3a52",
    black: light ? "#000000" : "#1b1e24", brightBlack: "#6a7385",
    red: "#e06c75", green: light ? "#1a7f37" : "#98c379", yellow: light ? "#9a6700" : "#e5c07b", blue: "#61afef",
    magenta: "#c678dd", cyan: light ? "#128c87" : "#36c6c0", white: light ? "#555555" : "#d6dae2", brightWhite: light ? "#000000" : "#ffffff",
  };
}

function renderTerminalTabs() {
  const box = $("terminal-tabs");
  box.textContent = "";
  state.terms.forEach((t, i) => {
    const b = document.createElement("button");
    b.textContent = `${i + 1}: ${t.title}`;
    b.className = (t === state.activeTerm ? "active" : "") + (t.exited ? " exited" : "");
    b.title = t.cwd || "";
    b.addEventListener("click", () => showTerminal(t));
    box.appendChild(b);
  });
}

function showTerminal(t) {
  state.activeTerm = t;
  for (const other of state.terms) other.el.hidden = other !== t;
  renderTerminalTabs();
  requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
}

async function newTerminal(cwd = state.root || (activeTab()?.path ? dirname(activeTab().path) : null)) {
  await togglePanel(true, { skipCreate: true });
  const el = document.createElement("div");
  el.className = "term-instance";
  $("terminal-host").appendChild(el);
  const term = new window.Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: Number(state.settings.terminalFontSize) || 13,
    cursorBlink: true, scrollback: 10000, theme: terminalTheme(), allowProposedApi: false,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  term.open(el);
  fit.fit();
  const t = { id: null, term, fit, el, title: "terminal", cwd, exited: false };
  state.terms.push(t);
  // Ctrl+C copies when text is selected (otherwise it interrupts); Ctrl+V pastes.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey) return true;
    const key = e.key.toLowerCase();
    if (key === "c" && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (key === "v") { navigator.clipboard.readText().then((text) => term.paste(text)); return false; }
    if (key === "`" || key === "b" || key === "p" || key === ",") return false;     // leave app shortcuts to the menu
    return true;
  });
  const started = await guard(() => api.terminal.start({ cwd, cols: term.cols, rows: term.rows }));
  if (!started) { term.write("\r\n[could not start the terminal shell]\r\n"); t.exited = true; showTerminal(t); return t; }
  t.id = started.id;
  t.title = started.shell.replace(/\.exe$/i, "");
  term.onData((data) => api.terminal.write(t.id, data));
  term.onResize(({ cols, rows }) => api.terminal.resize(t.id, cols, rows));
  showTerminal(t);
  return t;
}

async function killTerminal(t = state.activeTerm) {
  if (!t) return;
  if (t.id !== null && !t.exited) await guard(() => api.terminal.kill(t.id));
  t.term.dispose();
  t.el.remove();
  state.terms = state.terms.filter((x) => x !== t);
  if (state.terms.length) showTerminal(state.terms[state.terms.length - 1]);
  else { state.activeTerm = null; renderTerminalTabs(); togglePanel(false); }
}

async function togglePanel(force, { skipCreate = false } = {}) {
  const panel = $("panel");
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  $("panel-sash").hidden = !show;
  $("terminal-toggle").classList.toggle("active", show);
  if (show) {
    if (!state.terms.length && !skipCreate) await newTerminal();
    else if (state.activeTerm) showTerminal(state.activeTerm);
  } else {
    editor?.focus();
  }
}

api.terminal.onData((id, data) => { state.terms.find((t) => t.id === id)?.term.write(data); });
api.terminal.onExit((id, code) => {
  const t = state.terms.find((x) => x.id === id);
  if (!t) return;
  t.exited = true;
  t.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
  renderTerminalTabs();
});
new ResizeObserver(() => { if (state.activeTerm && !$("panel").hidden) state.activeTerm.fit.fit(); }).observe($("terminal-host"));
$("terminal-toggle").addEventListener("click", () => togglePanel());
$("terminal-close").addEventListener("click", () => togglePanel(false));
$("terminal-new").addEventListener("click", () => newTerminal());
$("terminal-kill").addEventListener("click", () => killTerminal());

// ------------------------------------------------------------------ status bar
function updateStatus() {
  const model = editor?.getModel();
  const show = Boolean(model);
  for (const id of ["status-position", "status-indent", "status-encoding", "status-eol", "status-language"]) $(id).hidden = !show;
  if (!model) return;
  const pos = editor.getPosition();
  const sel = editor.getSelection();
  const selected = sel && !sel.isEmpty() ? ` (${model.getValueInRange(sel).length} selected)` : "";
  $("status-position").textContent = `Ln ${pos?.lineNumber || 1}, Col ${pos?.column || 1}${selected}`;
  const opts = model.getOptions();
  $("status-indent").textContent = opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab Size: ${opts.tabSize}`;
  $("status-eol").textContent = model.getEOL() === "\r\n" ? "CRLF" : "LF";
  const lang = monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
  $("status-language").textContent = lang?.aliases?.[0] || model.getLanguageId();
}
$("status-position").addEventListener("click", () => editor.trigger("status", "editor.action.gotoLine"));
$("status-language").addEventListener("click", () => showQuickOpen("languages"));
$("status-eol").addEventListener("click", () => {
  const model = editor.getModel();
  if (!model) return;
  model.pushEOL(model.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
  updateStatus();
});
$("status-indent").addEventListener("click", () => {
  const model = editor.getModel();
  if (!model) return;
  const order = [2, 4, 8];
  const next = order[(order.indexOf(model.getOptions().tabSize) + 1) % order.length];
  model.updateOptions({ tabSize: next });
  updateStatus();
});

// ------------------------------------------------------------------ settings page
function showSettings() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    const value = state.settings[input.dataset.setting];
    if (input.type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
  }
  $("settings").hidden = false;
  document.querySelector("#settings [data-setting]").focus();
}

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", async () => {
    const key = input.dataset.setting;
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (["fontSize", "tabSize", "terminalFontSize"].includes(key)) {
      value = Number(value);
      if (!Number.isFinite(value) || value <= 0) return;
    }
    if (key === "terminalShell" && !String(value).trim()) value = "powershell.exe";
    await updateSettings({ [key]: value });
    if (key === "theme") applyTheme(value); else applyEditorSettings();
  });
}
$("settings-close").addEventListener("click", () => { $("settings").hidden = true; editor?.focus(); });
$("settings").addEventListener("mousedown", (e) => { if (e.target === $("settings")) $("settings").hidden = true; });

// Auto save when JaniX loses focus.
addEventListener("blur", () => { if (state.settings?.autoSave === "onFocusChange") saveAll({ onlyWithPath: true }); });
// Git status changes outside JaniX (commits, checkouts): refresh when the window regains focus.
addEventListener("focus", () => refreshGitSoon());

// ------------------------------------------------------------------ about, welcome, drag and drop
async function renderWelcomeRecent() {
  const box = $("welcome-recent");
  box.textContent = "";
  const recent = state.settings.recentFolders || [];
  if (!recent.length) { box.innerHTML = `<span style="color:var(--fg-muted)">No recent folders</span>`; return; }
  for (const folder of recent.slice(0, 6)) {
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = basename(folder);
    b.title = folder;
    b.addEventListener("click", () => openFolderChecked(folder));
    box.appendChild(b);
  }
}

async function openFolderChecked(folder) {
  if (await guard(() => api.fs.exists(folder))) openFolder(folder);
  else toast(`${folder} no longer exists.`, true);
}

$("about-button").addEventListener("click", () => ($("about").hidden = false));
$("about-close").addEventListener("click", () => ($("about").hidden = true));
$("about").addEventListener("mousedown", (e) => { if (e.target === $("about")) $("about").hidden = true; });
$("open-folder-button").addEventListener("click", () => runCommand("openFolderDialog"));
document.querySelectorAll("#welcome [data-command]").forEach((b) => b.addEventListener("click", () => runCommand(b.dataset.command)));

let dragDepth = 0;
addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging-files"); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging-files"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging-files");
  for (const file of e.dataTransfer.files) {
    const path = api.pathForFile(file);
    if (!path) continue;
    // A dropped folder opens as the workspace; anything else opens as a file.
    const isFolder = await api.fs.readDir(path).then(() => true, () => false);
    if (isFolder) openFolder(path);
    else openFile(path);
  }
});

// ------------------------------------------------------------------ commands
async function runCommand(command, ...args) {
  const tab = activeTab();
  switch (command) {
    case "newFile": return newUntitled();
    case "openFileDialog": {
      const files = (await guard(() => api.dialog.openFiles())) || [];
      for (const f of files) await openFile(f);
      return;
    }
    case "openFolderDialog": {
      const dir = await guard(() => api.dialog.openFolder());
      if (dir) { openFolder(dir); showView("explorer"); renderWelcomeRecent(); }
      return;
    }
    case "openFolder": return openFolderChecked(args[0]);
    case "openFile": return openFile(args[0]);
    case "save": return saveTab(tab);
    case "saveAs": return saveTab(tab, { saveAs: true });
    case "saveAll": return saveAll();
    case "closeTab": return tab && closeTab(tab.id);
    case "closeFolder": return closeFolder();
    case "quickOpen": return showQuickOpen("files");
    case "showSearch": return showView("search");
    case "toggleSidebar": return toggleSidebar();
    case "toggleTerminal": return togglePanel();
    case "newTerminal": return newTerminal();
    case "toggleSplit": return toggleSplit();
    case "markdownPreview": return markdownPreview();
    case "openSettings": return showSettings();
    case "toggleWordWrap": {
      const wordWrap = state.settings.wordWrap === "on" ? "off" : "on";
      await updateSettings({ wordWrap });
      return applyEditorSettings();
    }
    case "toggleMinimap": {
      await updateSettings({ minimap: !state.settings.minimap });
      return applyEditorSettings();
    }
    case "setTheme": applyTheme(args[0]); return updateSettings({ theme: args[0] });
    case "zoom": {
      const fontSize = args[0] === 0 ? 14 : Math.max(8, Math.min(40, Number(state.settings.fontSize) + args[0]));
      await updateSettings({ fontSize });
      return applyEditorSettings();
    }
    case "about": $("about").hidden = false; return;
    case "editor": {
      // Undo/redo and other editor actions from the menu; fall back to the
      // browser for plain inputs such as the search box.
      const focusedInput = document.activeElement?.matches("input") && !document.activeElement.closest(".monaco-editor");
      if (focusedInput && (args[0] === "undo" || args[0] === "redo")) return document.execCommand(args[0]);
      if (!editor.getModel() && args[0] !== "editor.action.quickCommand") return;
      editor.focus();
      return editor.trigger("menu", args[0], null);
    }
  }
}

api.app.onMenu((command, ...args) => runCommand(command, ...args));

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); cycleTabs(e.shiftKey ? -1 : 1); }
  if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) { e.preventDefault(); showView("explorer"); $("tree").focus(); }
  if (e.key === "Escape") {
    if (!$("about").hidden) $("about").hidden = true;
    if (!$("settings").hidden) { $("settings").hidden = true; editor?.focus(); }
  }
});

// Closing the window: offer to save unsaved tabs first.
api.app.onRequestClose(async () => {
  const dirty = state.tabs.filter(isDirty);
  if (dirty.length) {
    const names = dirty.map((t) => t.title).join(", ");
    const choice = await guard(() => api.dialog.confirm({
      message: `Do you want to save the changes to ${dirty.length === 1 ? names : `${dirty.length} files`}?`,
      detail: dirty.length > 1 ? names : "Your changes will be lost if you don't save them.",
      buttons: ["Save All", "Don't Save", "Cancel"],
    }));
    if (choice === 2 || choice === undefined) return;
    if (choice === 0 && !(await saveAll())) return;
  }
  saveSession();
  api.app.confirmClose();
});

// ------------------------------------------------------------------ start-up
(async function start() {
  state.settings = await api.settings.get();
  monaco = await loadMonaco();
  defineThemes();
  editor = createEditor(0);
  applyTheme(state.settings.theme);

  if (!state.settings.sidebarVisible) document.body.classList.add("sidebar-hidden");
  if (state.settings.sidebarWidth) $("sidebar").style.width = `${state.settings.sidebarWidth}px`;
  if (state.settings.panelHeight) $("panel").style.height = `${state.settings.panelHeight}px`;
  $("about-version").textContent = "Version 1.1.0";
  renderWelcomeRecent();
  renderTabs();
  updateStatus();

  // Restore the last session, unless JaniX was opened on a specific file or folder.
  const target = await guard(() => api.app.launchTarget());
  const session = state.settings.session || {};
  const folder = target?.isDir ? target.path : target ? null : session.root || state.settings.lastFolder;
  if (folder && (await guard(() => api.fs.exists(folder)))) await openFolder(folder);
  if (target && !target.isDir) {
    await openFile(target.path);
  } else if (!target && session.files?.length) {
    for (const f of session.files) if (await guard(() => api.fs.exists(f))) await openFile(f);
    const active = state.tabs.find((t) => samePath(t.path, session.active));
    if (active) activateTab(active.id);
  }
})();
