// JaniX Mobile: the JaniX editor for Android, iPhone and the web. Same UI and
// features as JaniX for Windows (tabs, explorer, quick open, search, terminal,
// split editor, markdown preview, git status, settings), with CodeMirror as
// the editor, because it is built for touch screens.
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import JSZip from "jszip";
import { highlightCode, classHighlighter } from "@lezer/highlight";
import { undo, redo, selectAll, toggleComment, cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown, indentMore } from "@codemirror/commands";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { Annotation, Text } from "@codemirror/state";
import { Capacitor } from "@capacitor/core";
import * as vfs from "./vfs.js";
import * as gitops from "./gitops.js";
import { createShell } from "./shell.js";
import { EditorView, EditorState, languages, LanguageDescription, themeExtension, optionsExtension, makeCompartments, baseExtensions, languageFor } from "./editor.js";

const VERSION = "1.1.0";
const $ = (id) => document.getElementById(id);
const { basename, dirname, join } = vfs;
const native = Capacitor.isNativePlatform();

const DEFAULT_SETTINGS = {
  theme: "janix-dark", fontSize: 14, fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, 'Roboto Mono', monospace",
  tabSize: 4, wordWrap: "on", lineNumbers: "on", renderWhitespace: "selection", cursorStyle: "line", autoSave: "afterDelay",
  terminalFontSize: 13, keybar: true, sidebarVisible: true, sidebarWidth: 0, panelHeight: 0,
  gitName: "", gitEmail: "", gitToken: "", recentFolders: [], lastFolder: null, session: null,
};

const state = {
  settings: null,
  root: null,
  tabs: [],                   // { id, path, title, doc, savedDoc, eol, states: [left, right], lang }
  expanded: new Set(),
  selectedPath: null,
  fileIndex: null,
  untitledCount: 0,
  searchCase: false,
  git: null,
  terms: [],
  activeTerm: null,
};
let nextTabId = 1;
const compartments = makeCompartments();
const syncAnnotation = Annotation.define();

const panes = [
  { el: () => $("pane-left"), host: () => $("editor"), view: null, tabId: null },
  { el: () => $("pane-right"), host: () => $("editor2"), view: null, tabId: null },
];
let focusedPane = 0;
let rightMode = null;
let previewTabId = null;
let lastFocus = "editor";     // where the coding keys send input: "editor" or "terminal"

// ------------------------------------------------------------------ helpers
const samePath = (a, b) => a && b && a === b;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isNarrow = () => matchMedia("(max-width: 760px)").matches;

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
  catch (error) { toast(error.message || String(error), true); return undefined; }
}

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

// ------------------------------------------------------------------ settings (stored on the device)
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("janix.settings") || "{}"); } catch { saved = {}; }
  return { ...DEFAULT_SETTINGS, ...saved };
}
function updateSettings(patch) {
  Object.assign(state.settings, patch);
  try { localStorage.setItem("janix.settings", JSON.stringify(state.settings)); } catch { /* private mode */ }
}
function remember(key, value) {
  const list = (state.settings[key] || []).filter((x) => x !== value);
  list.unshift(value);
  updateSettings({ [key]: list.slice(0, 12) });
}

// ------------------------------------------------------------------ dialogs (same shape as the desktop bridge)
function showDialog({ message, detail = "", buttons = ["OK"], input = null }) {
  return new Promise((resolve) => {
    $("dialog-message").textContent = message;
    $("dialog-detail").textContent = detail;
    $("dialog-detail").hidden = !detail;
    const field = $("dialog-input");
    field.hidden = input === null;
    if (input !== null) { field.value = input.value || ""; field.placeholder = input.placeholder || ""; }
    const box = $("dialog-buttons");
    box.textContent = "";
    const finish = (i) => { $("dialog").hidden = true; document.removeEventListener("keydown", onKey, true); resolve(input !== null ? (i === 0 ? field.value.trim() || null : null) : i); };
    buttons.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = i === 0 ? "primary" : "secondary";
      b.addEventListener("click", () => finish(i));
      box.appendChild(b);
    });
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(input !== null ? 1 : buttons.length - 1); }
      if (e.key === "Enter" && input !== null) { e.preventDefault(); finish(0); }
    };
    document.addEventListener("keydown", onKey, true);
    $("dialog").hidden = false;
    if (input !== null) setTimeout(() => { field.focus(); field.select(); }, 50); else box.firstChild?.focus();
  });
}
const dialog = {
  confirm: (o) => showDialog(o),
  prompt: (message, value = "", placeholder = "") => showDialog({ message, buttons: ["OK", "Cancel"], input: { value, placeholder } }),
};

// ------------------------------------------------------------------ editors
function createView(paneIndex) {
  const pane = panes[paneIndex];
  pane.view = new EditorView({ parent: pane.host(), state: EditorState.create({ doc: "" }) });
  pane.view.dom.hidden = true;
  pane.view.contentDOM.addEventListener("focus", () => { lastFocus = "editor"; focusPane(paneIndex); updateKeybar(); });
  return pane.view;
}
const editor = () => panes[focusedPane].view;

function stateFor(tab, paneIndex) {
  return EditorState.create({
    doc: tab.doc,
    extensions: [
      ...baseExtensions({ compartments, settings: state.settings, onUpdate: (u) => onEditorUpdate(u, tab, paneIndex), onSave: () => runCommand("save") }),
      compartments.language.of(tab.lang?.support || []),
    ],
  });
}

function onEditorUpdate(update, tab, paneIndex) {
  if (update.docChanged) {
    tab.doc = update.state.doc;
    // The same file in both panes: mirror the edit into the other one.
    const other = panes[1 - paneIndex];
    if (other.tabId === tab.id && other.view && !update.transactions.some((tr) => tr.annotation(syncAnnotation))) {
      other.view.dispatch({ changes: update.changes, annotations: syncAnnotation.of(true) });
    }
    if (!update.transactions.some((tr) => tr.annotation(syncAnnotation))) {
      renderTabs();
      if (state.settings.autoSave === "afterDelay" && tab.path) autoSaveSoon(tab);
      if (rightMode === "preview" && previewTabId === tab.id) renderPreviewSoon();
    }
  }
  if ((update.selectionSet || update.docChanged) && paneIndex === focusedPane) updateStatus();
}

function reconfigure(view) {
  view.dispatch({ effects: [
    compartments.theme.reconfigure(themeExtension(state.settings.theme, state.settings)),
    compartments.options.reconfigure(optionsExtension(state.settings)),
  ] });
}

function focusPane(index) {
  if (index === 1 && rightMode !== "editor") index = 0;
  if (focusedPane === index) return;
  focusedPane = index;
  panes[0].el().classList.toggle("focused-pane", rightMode === "editor" && index === 0);
  panes[1].el().classList.toggle("focused-pane", rightMode === "editor" && index === 1);
  const tab = activeTab();
  state.selectedPath = tab?.path || state.selectedPath;
  markSelectedInTree();
  renderTabs();
  updateStatus();
}

async function loadLanguage(tab, desc = languageFor(tab.title)) {
  if (!desc) { tab.lang = null; return; }
  const support = await desc.load().catch(() => null);
  if (!support) return;
  tab.lang = { name: desc.name, support };
  panes.forEach((pane, i) => {
    if (pane.tabId === tab.id) pane.view.dispatch({ effects: compartments.language.reconfigure(support) });
    else if (tab.states[i]) tab.states[i] = null;
  });
  updateStatus();
  if (rightMode === "preview" && previewTabId === tab.id) renderPreview();
}

// ------------------------------------------------------------------ tabs
const tabById = (id) => state.tabs.find((t) => t.id === id) || null;
const activeTab = () => tabById(panes[focusedPane].tabId);
const isDirty = (tab) => !tab.doc.eq(tab.savedDoc);

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
      <span class="tab-label">${escapeHtml(tab.title)}</span><button class="tab-close" title="Close" aria-label="Close ${escapeHtml(tab.title)}"><span>✕</span></button>`;
    el.addEventListener("click", (e) => { if (e.target.closest(".tab-close")) closeTab(tab.id); else activateTab(tab.id); });
    bar.appendChild(el);
    if (tab.id === panes[focusedPane].tabId) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  $("welcome").hidden = state.tabs.length > 0;
  $("save-button").classList.toggle("dirty", Boolean(activeTab() && isDirty(activeTab())));
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

function activateTab(id, paneIndex = focusedPane, { focus = true } = {}) {
  const pane = panes[paneIndex];
  const view = pane.view;
  const current = tabById(pane.tabId);
  if (current && current.id !== id) current.states[paneIndex] = view.state;
  pane.tabId = id;
  const tab = tabById(id);
  if (tab) {
    let st = tab.states[paneIndex];
    if (!st || !st.doc.eq(tab.doc)) st = stateFor(tab, paneIndex);
    view.setState(st);
    reconfigure(view);
    view.dom.hidden = false;
    if (paneIndex === focusedPane) {
      if (focus && !isNarrow()) view.focus();
      state.selectedPath = tab.path;
      markSelectedInTree();
    }
  } else {
    view.dom.hidden = true;
  }
  renderTabs();
  updateStatus();
  saveSession();
}

function newTab(text, path, title) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const doc = Text.of(text.split(/\r?\n/));
  const tab = { id: nextTabId++, path, title, doc, savedDoc: doc, eol, states: [null, null], lang: null };
  state.tabs.push(tab);
  activateTab(tab.id);
  loadLanguage(tab);
  return tab;
}

const autoSaveSoon = debounce((tab) => { if (state.tabs.includes(tab) && tab.path && isDirty(tab)) saveTab(tab); }, 1000);
const renderPreviewSoon = debounce(() => renderPreview(), 150);

async function openFile(path, { line, column } = {}) {
  const existing = state.tabs.find((t) => samePath(t.path, path));
  if (existing) activateTab(existing.id);
  else {
    const text = await guard(() => vfs.readFile(path));
    if (text === undefined) return;
    newTab(text, path, basename(path));
  }
  if (isNarrow()) closeDrawer();
  if (line) {
    const view = editor();
    const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: Math.min(l.from + (column || 1) - 1, l.to) }, scrollIntoView: true });
    view.focus();
  }
}

function newUntitled() {
  state.untitledCount += 1;
  newTab("", null, `Untitled-${state.untitledCount}`);
  editor().focus();
}

function retargetTab(tab, newPath) {
  tab.path = newPath;
  tab.title = basename(newPath);
  loadLanguage(tab);
}

async function saveTab(tab, { saveAs = false } = {}) {
  if (!tab) return false;
  let target = tab.path;
  if (!target || saveAs) {
    const folder = state.root || join(vfs.PROJECTS, "scratch");
    const answer = await dialog.prompt("Save as (path inside the project)", tab.path ? tab.path.slice(folder.length + 1) : tab.title);
    if (!answer) return false;
    target = answer.startsWith("/") ? answer : join(folder, answer);
  }
  const text = tab.doc.toString().replace(/\n/g, tab.eol);
  const ok = await guard(() => vfs.writeFile(target, text));
  if (!ok) return false;
  if (target !== tab.path) {
    retargetTab(tab, target);
    state.fileIndex = null;
    refreshTree();
  }
  tab.savedDoc = tab.doc;
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
    const choice = await dialog.confirm({
      message: `Do you want to save the changes you made to ${tab.title}?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ["Save", "Don't Save", "Cancel"],
    });
    if (choice === 2) return;
    if (choice === 0 && !(await saveTab(tab))) return;
  }
  const index = state.tabs.indexOf(tab);
  state.tabs.splice(index, 1);
  if (previewTabId === id) closeRightPane();
  const next = state.tabs[Math.min(index, state.tabs.length - 1)] || null;
  panes.forEach((pane, i) => { if (pane.tabId === id) { pane.tabId = null; activateTab(next ? next.id : null, i, { focus: false }); } });
  if (rightMode === "editor" && !panes[1].tabId) closeRightPane();
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
  updateSettings({ session: { root: state.root, files, active: activeTab()?.path || null } });
}

// ------------------------------------------------------------------ split editor and markdown preview
function openRightPane(mode) {
  rightMode = mode;
  document.body.dataset.right = mode;
  $("pane-right").hidden = false;
  $("editor2").hidden = mode !== "editor";
  $("preview").hidden = mode !== "preview";
  if (mode === "editor" && !panes[1].view) createView(1);
}

function closeRightPane() {
  if (!rightMode) return;
  if (panes[1].view && panes[1].tabId) {
    const tab = tabById(panes[1].tabId);
    if (tab) tab.states[1] = null;
    panes[1].tabId = null;
    panes[1].view.dom.hidden = true;
  }
  rightMode = null;
  previewTabId = null;
  delete document.body.dataset.right;
  $("pane-right").hidden = true;
  panes[0].el().classList.remove("focused-pane");
  focusPane(0);
  renderTabs();
}

function toggleSplit() {
  if (rightMode === "editor") return closeRightPane();
  const tab = activeTab();
  if (!tab) return toast("Open a file first, then split the editor.");
  if (rightMode) closeRightPane();
  openRightPane("editor");
  activateTab(tab.id, 1, { focus: false });
  focusPane(1);
}

function markdownPreview() {
  const tab = activeTab();
  if (!tab || !/\.(md|markdown|mdx)$/i.test(tab.title)) return toast("Open a Markdown (.md) file to preview it.");
  if (rightMode === "preview" && previewTabId === tab.id) return closeRightPane();
  if (rightMode) closeRightPane();
  openRightPane("preview");
  previewTabId = tab.id;
  renderPreview();
}

function renderPreview() {
  const tab = tabById(previewTabId);
  if (!tab || rightMode !== "preview") return;
  $("pane-right-title").textContent = `Preview: ${tab.title}`;
  const article = $("preview");
  const scroll = article.scrollTop;
  article.innerHTML = DOMPurify.sanitize(marked.parse(tab.doc.toString(), { gfm: true }));
  for (const code of article.querySelectorAll("pre code[class*='language-']")) {
    const lang = code.className.match(/language-([\w+#-]+)/)?.[1];
    const desc = lang && LanguageDescription.matchLanguageName(languages, lang, true);
    if (!desc) continue;
    desc.load().then((support) => {
      const text = code.textContent;
      code.textContent = "";
      highlightCode(text, support.language.parser.parse(text), classHighlighter,
        (t, classes) => { const s = document.createElement("span"); s.textContent = t; if (classes) s.className = classes; code.appendChild(s); },
        () => code.appendChild(document.createTextNode("\n")));
    }).catch(() => {});
  }
  article.scrollTop = scroll;
}

$("pane-right-close").addEventListener("click", closeRightPane);
$("preview").addEventListener("click", (e) => {
  const link = e.target.closest("a[href]");
  if (!link) return;
  e.preventDefault();
  if (/^https?:/.test(link.href)) window.open(link.href, "_blank", "noopener");
});

// ------------------------------------------------------------------ projects and explorer
async function openFolder(dir) {
  state.root = dir;
  state.expanded = new Set([dir]);
  state.fileIndex = null;
  state.git = null;
  $("folder-name").textContent = basename(dir);
  $("folder-name").title = dir;
  $("status-folder").textContent = basename(dir);
  $("no-folder").hidden = true;
  updateSettings({ lastFolder: dir });
  remember("recentFolders", dir);
  await refreshTree();
  refreshGit();
  renderWelcomeRecent();
  updateTitle();
  saveSession();
}

async function closeFolder() {
  for (const tab of [...state.tabs]) await closeTab(tab.id);
  if (state.tabs.length) return;
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
  const fragment = document.createDocumentFragment();
  await renderDir(state.root, 0, fragment);
  $("tree").textContent = "";
  $("tree").appendChild(fragment);
  markSelectedInTree();
  decorateGit();
}

async function renderDir(dir, depth, parent) {
  const entries = await guard(() => vfs.readDir(dir));
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
      `<span class="label">${escapeHtml(entry.name)}</span><span class="git-badge"></span><button class="row-more" aria-label="More actions">⋯</button>`;
    parent.appendChild(row);
    if (open) await renderDir(entry.path, depth + 1, parent);
  }
}

function markSelectedInTree() {
  for (const el of document.querySelectorAll(".node.selected")) el.classList.remove("selected");
  if (!state.selectedPath) return;
  for (const el of document.querySelectorAll(".node")) {
    if (el.dataset.path === state.selectedPath) { el.classList.add("selected"); break; }
  }
}

$("tree").addEventListener("click", async (e) => {
  const row = e.target.closest(".node");
  if (!row || row.querySelector("input")) return;
  if (e.target.closest(".row-more")) { const r = e.target.getBoundingClientRect(); return treeMenu(row, r.left, r.bottom); }
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
  treeMenu(e.target.closest(".node"), e.clientX, e.clientY);
});

function treeMenu(row, x, y) {
  if (!state.root) return;
  const target = row ? row.dataset.path : state.root;
  const isDir = row ? Boolean(row.dataset.dir) : true;
  if (row) { state.selectedPath = target; markSelectedInTree(); }
  const folder = isDir ? target : dirname(target);
  const items = [
    ["New File…", () => createEntry(folder, false)],
    ["New Folder…", () => createEntry(folder, true)],
    ["Import Files Here…", () => importFiles(folder)],
  ];
  if (row) {
    items.push(null,
      ["Rename…", () => renameEntry(row)],
      ["Duplicate", () => duplicateEntry(target)],
      ["Delete", () => deleteEntry(target)],
      null,
      ["Open in Integrated Terminal", () => newTerminal(folder)],
      ["Copy Path", () => navigator.clipboard?.writeText(target)]);
    if (!isDir) items.push(["Share / Export File", () => exportFile(target)]);
  }
  showContextMenu(x, y, items);
}

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
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
}
document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#contextmenu")) $("contextmenu").hidden = true; });

function askName(anchorRow, depthPx, initial) {
  return new Promise((resolve) => {
    const row = document.createElement("div");
    row.className = "node";
    row.style.paddingLeft = depthPx;
    const input = document.createElement("input");
    input.value = initial || "";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.enterKeyHint = "done";
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
const rowFor = (path) => [...document.querySelectorAll(".node")].find((el) => el.dataset.path === path) || null;

async function createEntry(folder, isDir) {
  if (!state.root) return;
  if (isNarrow()) openDrawer();
  if (folder !== state.root && !state.expanded.has(folder)) { state.expanded.add(folder); await refreshTree(); }
  const anchor = rowFor(folder);
  const depth = anchor ? `${parseInt(anchor.style.paddingLeft, 10) + 12}px` : "10px";
  const name = await askName(anchor, depth, "");
  if (!name) return;
  if (/[\\:*?"<>|]/.test(name)) { toast(`"${name}" contains characters that are not allowed in names.`, true); return; }
  const target = vfs.resolvePath(folder, name);
  const ok = await guard(() => (isDir ? vfs.createFolder(target) : vfs.createFile(target)));
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
  if (!(await guard(() => vfs.rename(from, to)))) return;
  for (const tab of state.tabs) {
    if (tab.path && (tab.path === from || tab.path.startsWith(from + "/"))) retargetTab(tab, to + tab.path.slice(from.length));
  }
  state.fileIndex = null;
  await refreshTree();
  refreshGitSoon();
  renderTabs();
}

async function duplicateEntry(target) {
  const ext = /\.[^./]+$/.exec(basename(target))?.[0] || "";
  let copyPath = target.slice(0, target.length - ext.length) + " copy" + ext;
  for (let i = 2; await vfs.exists(copyPath); i++) copyPath = target.slice(0, target.length - ext.length) + ` copy ${i}` + ext;
  if (await guard(() => vfs.copy(target, copyPath))) { state.fileIndex = null; await refreshTree(); refreshGitSoon(); }
}

async function deleteEntry(target) {
  const choice = await dialog.confirm({
    message: `Delete '${basename(target)}'?`,
    detail: "This cannot be undone. Files deleted in JaniX Mobile are removed from this device.",
    buttons: ["Delete", "Cancel"],
  });
  if (choice !== 0) return;
  if (!(await guard(() => vfs.remove(target)))) return;
  for (const tab of [...state.tabs]) {
    if (tab.path && (tab.path === target || tab.path.startsWith(target + "/"))) { tab.savedDoc = tab.doc; await closeTab(tab.id); }
  }
  state.fileIndex = null;
  await refreshTree();
  refreshGitSoon();
}

document.querySelectorAll("#explorer-view .view-actions button").forEach((b) => b.addEventListener("click", () => {
  const action = b.dataset.action;
  const selected = state.selectedPath;
  const folder = selected && rowFor(selected)?.dataset.dir ? selected : selected ? dirname(selected) : state.root;
  if (!state.root) return showProjects();
  if (action === "newFile") createEntry(folder || state.root, false);
  if (action === "newFolder") createEntry(folder || state.root, true);
  if (action === "refresh") { state.fileIndex = null; refreshTree(); refreshGit(); }
  if (action === "collapse") { state.expanded = new Set([state.root]); refreshTree(); }
}));

// Projects picker (the phone version of Open Folder).
async function showProjects() {
  const list = $("projects-list");
  list.textContent = "";
  const names = (await guard(() => vfs.listProjects())) || [];
  if (!names.length) list.innerHTML = `<p class="muted">No projects yet. Create one, clone a repository or import a ZIP.</p>`;
  for (const name of names) {
    const dir = join(vfs.PROJECTS, name);
    const row = document.createElement("div");
    row.className = "project-row" + (dir === state.root ? " current" : "");
    row.innerHTML = `<button class="project-open"><b>${escapeHtml(name)}</b></button><button class="project-delete" aria-label="Delete ${escapeHtml(name)}">🗑</button>`;
    row.querySelector(".project-open").addEventListener("click", () => { $("projects").hidden = true; switchProject(dir); });
    row.querySelector(".project-delete").addEventListener("click", async () => {
      const choice = await dialog.confirm({ message: `Delete the project '${name}'?`, detail: "All of its files are removed from this device.", buttons: ["Delete", "Cancel"] });
      if (choice !== 0) return;
      if (dir === state.root) await closeFolder();
      if (dir === state.root) return;
      await guard(() => vfs.remove(dir));
      updateSettings({ recentFolders: state.settings.recentFolders.filter((f) => f !== dir) });
      renderWelcomeRecent();
      showProjects();
    });
    list.appendChild(row);
  }
  $("projects").hidden = false;
}
$("projects-close").addEventListener("click", () => ($("projects").hidden = true));
document.querySelectorAll("#projects [data-command]").forEach((b) => b.addEventListener("click", () => { $("projects").hidden = true; runCommand(b.dataset.command); }));

async function switchProject(dir) {
  if (dir === state.root) return;
  if (state.root) {
    await closeFolder();
    if (state.root) return;      // the user cancelled a save prompt
  }
  await openFolder(dir);
  if (isNarrow()) openDrawer();
}

async function newProject() {
  const name = await dialog.prompt("New project name", "", "my-project");
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) return toast("Project names cannot contain / \\ : * ? \" < > |", true);
  const dir = join(vfs.PROJECTS, name);
  if (!(await guard(() => vfs.createFolder(dir)))) return;
  await switchProject(dir);
}

async function gitClone() {
  const url = await dialog.prompt("Clone a Git repository (HTTPS URL)", "", "https://github.com/user/repo");
  if (!url) return;
  if (!/^https:\/\//.test(url)) return toast("Use an https:// URL, for example https://github.com/user/repo", true);
  const name = url.replace(/\.git$/, "").replace(/\/$/, "").split("/").pop();
  const dir = join(vfs.PROJECTS, name);
  if (await vfs.exists(dir)) return toast(`A project named ${name} already exists.`, true);
  toast(`Cloning ${name}…`);
  const t = await newTerminal(vfs.PROJECTS);
  t.shell.run(`git clone ${url}`);
}

// Import and export: phones have no folders to open directly, so files come in
// through the file picker or a ZIP, and go out as a ZIP through the share sheet.
let importTarget = null;
function importFiles(folder = state.root) {
  if (!folder) return toast("Open a project first.");
  importTarget = folder;
  $("file-input").value = "";
  $("file-input").click();
}
$("file-input").addEventListener("change", async () => {
  const files = [...$("file-input").files];
  for (const file of files) await guard(async () => vfs.writeFile(join(importTarget, file.name), new Uint8Array(await file.arrayBuffer())));
  toast(`Imported ${files.length} file${files.length === 1 ? "" : "s"}.`);
  state.fileIndex = null;
  await refreshTree();
  refreshGitSoon();
});

function importZip() { $("zip-input").value = ""; $("zip-input").click(); }
$("zip-input").addEventListener("change", async () => {
  const file = $("zip-input").files[0];
  if (!file) return;
  await guard(async () => {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !n.startsWith("__MACOSX/"));
    if (!names.length) throw new Error("The ZIP file is empty.");
    // Drop a single top-level folder, as GitHub's "Download ZIP" adds one.
    const tops = new Set(names.map((n) => n.split("/")[0]));
    const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? [...tops][0] + "/" : "";
    let name = (strip ? strip.slice(0, -1) : file.name.replace(/\.zip$/i, "")).replace(/[\\/:*?"<>|]/g, "-");
    let dir = join(vfs.PROJECTS, name);
    for (let i = 2; await vfs.exists(dir); i++) dir = join(vfs.PROJECTS, `${name}-${i}`);
    toast(`Importing ${names.length} files…`);
    for (const n of names) await vfs.writeFile(join(dir, n.slice(strip.length)), await zip.files[n].async("uint8array"));
    await switchProject(dir);
    toast(`Imported ${basename(dir)}.`);
  });
});

async function saveOrShare(filename, blob, mime) {
  if (native) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(",")[1]); r.readAsDataURL(blob); });
    const written = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
    await Share.share({ title: filename, files: [written.uri] });
    return;
  }
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function exportProject() {
  if (!state.root) return toast("Open a project first.");
  await guard(async () => {
    const zip = new JSZip();
    const name = basename(state.root);
    for (const rel of await vfs.listFiles(state.root)) zip.file(`${name}/${rel}`, await vfs.readBytes(join(state.root, rel)));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    await saveOrShare(`${name}.zip`, blob, "application/zip");
  });
}
async function exportFile(path) {
  await guard(async () => saveOrShare(basename(path), new Blob([await vfs.readBytes(path)]), "application/octet-stream"));
}

// ------------------------------------------------------------------ git status
async function refreshGit() {
  if (!state.root) return;
  const root = state.root;
  const result = await gitops.status(root).catch(() => null);
  if (root !== state.root) return;
  state.git = result;
  $("status-branch").textContent = result?.branch || "";
  decorateGit();
}
const refreshGitSoon = debounce(refreshGit, 600);

const GIT_LETTER = { modified: "M", untracked: "U", added: "A", deleted: "D", conflict: "!" };
function decorateGit() {
  const files = state.git?.files || {};
  const changed = Object.keys(files);
  for (const row of document.querySelectorAll("#tree .node")) {
    row.classList.remove("git-modified", "git-untracked", "git-added", "git-deleted", "git-conflict", "git-folder");
    const badge = row.querySelector(".git-badge");
    if (badge) badge.textContent = "";
    if (!changed.length || !row.dataset.path) continue;
    const p = row.dataset.path;
    if (row.dataset.dir) {
      if (changed.some((f) => f.startsWith(p + "/"))) row.classList.add("git-folder");
    } else if (files[p]) {
      row.classList.add(`git-${files[p]}`);
      if (badge) badge.textContent = GIT_LETTER[files[p]];
    }
  }
}

// ------------------------------------------------------------------ quick open, command palette, language picker
function fuzzyScore(query, text) {
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
  input.placeholder = { files: state.root ? "Search files by name" : "Open a project to search its files", languages: "Select language mode", commands: "Type a command" }[mode];
  input.focus();
  if (mode === "files" && state.root && !state.fileIndex) state.fileIndex = (await guard(() => vfs.listFiles(state.root))) || [];
  updateQuickOpen();
}
function hideQuickOpen() { $("quickopen").hidden = true; if (!isNarrow()) editor()?.focus(); }

function updateQuickOpen() {
  const query = $("quickopen-input").value.trim().toLowerCase();
  const list = $("quickopen-list");
  if (quickMode === "files") {
    const files = state.fileIndex || [];
    const recent = state.tabs.filter((t) => t.path && state.root && t.path.startsWith(state.root + "/")).map((t) => t.path.slice(state.root.length + 1));
    const source = query ? files : [...new Set([...recent, ...files])];
    quickItems = source.map((rel) => {
      const name = basename(rel);
      const m = query ? fuzzyScore(query, name) || fuzzyScore(query, rel) : { score: 0, positions: [] };
      return m && { rel, name, score: m.score + (fuzzyScore(query, name) ? 10 : 0), positions: fuzzyScore(query, name)?.positions || [] };
    }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 60);
  } else if (quickMode === "languages") {
    quickItems = languages.map((l) => ({ id: l.name, name: l.name, desc: l.extensions.join(", ") }))
      .filter((l) => !query || l.name.toLowerCase().includes(query))
      .slice(0, 80);
  } else {
    quickItems = COMMANDS.filter(([label]) => label)
      .map(([label, cmd, arg]) => ({ name: label, cmd, arg, m: query ? fuzzyScore(query, label) : { score: 0, positions: [] } }))
      .filter((c) => c.m).sort((a, b) => b.m.score - a.m.score).map((c) => ({ ...c, positions: c.m.positions }));
  }
  quickIndex = 0;
  list.textContent = "";
  quickItems.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "qo-item" + (i === 0 ? " active" : "");
    const hl = (s, pos) => [...s].map((ch, k) => (pos.includes(k) ? `<b>${escapeHtml(ch)}</b>` : escapeHtml(ch))).join("");
    if (quickMode === "files") {
      const dir = item.rel.length > item.name.length ? item.rel.slice(0, -item.name.length - 1) : "";
      el.innerHTML = `<span class="qo-name">${hl(item.name, item.positions)}</span><span class="qo-dir">${escapeHtml(dir)}</span>`;
    } else if (quickMode === "languages") {
      el.innerHTML = `<span class="qo-name">${escapeHtml(item.name)}</span><span class="qo-dir">${escapeHtml(item.desc)}</span>`;
    } else {
      el.innerHTML = `<span class="qo-name">${hl(item.name, item.positions)}</span>`;
    }
    el.addEventListener("click", () => pickQuick(i));
    list.appendChild(el);
  });
  if (!quickItems.length) list.innerHTML = `<div class="qo-item"><span class="qo-dir">${quickMode === "files" && !state.root ? "No project is open." : "No matches."}</span></div>`;
}

function pickQuick(i) {
  const item = quickItems[i];
  hideQuickOpen();
  if (!item) return;
  if (quickMode === "files") openFile(join(state.root, item.rel));
  else if (quickMode === "languages") {
    const tab = activeTab();
    if (tab) loadLanguage(tab, languages.find((l) => l.name === item.id));
  } else runCommand(item.cmd, item.arg);
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
$("quickopen").addEventListener("pointerdown", (e) => { if (e.target === $("quickopen")) hideQuickOpen(); });

// ------------------------------------------------------------------ search in files
async function runSearch() {
  const query = $("search-input").value;
  const out = $("search-results");
  out.textContent = "";
  if (!query) { $("search-summary").textContent = ""; return; }
  if (!state.root) { $("search-summary").textContent = "Open a project to search in its files."; return; }
  $("search-summary").textContent = "Searching…";
  const results = (await guard(() => vfs.searchInFiles(state.root, query, { caseSensitive: state.searchCase }))) || [];
  const byFile = new Map();
  for (const r of results) { if (!byFile.has(r.path)) byFile.set(r.path, []); byFile.get(r.path).push(r); }
  $("search-summary").textContent = results.length ? `${results.length}${results.length >= 2000 ? "+" : ""} results in ${byFile.size} files` : "No results found.";
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
      const trimmed = Math.max(0, start - 30);
      row.innerHTML = `${trimmed ? "…" : ""}${escapeHtml(hit.text.slice(trimmed, start))}<mark>${escapeHtml(hit.text.slice(start, start + query.length))}</mark>${escapeHtml(hit.text.slice(start + query.length))}`;
      row.addEventListener("click", () => openFile(file, { line: hit.line, column: hit.column }));
      fragment.appendChild(row);
    }
  }
  out.appendChild(fragment);
}
$("search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
$("search-case").addEventListener("click", () => { state.searchCase = !state.searchCase; $("search-case").classList.toggle("on", state.searchCase); runSearch(); });

// ------------------------------------------------------------------ views, drawer and layout
function showView(view) {
  if (isNarrow()) openDrawer();
  else if (document.body.classList.contains("sidebar-hidden")) toggleSidebar(true);
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("active", b.dataset.view === view);
  $("explorer-view").hidden = view !== "explorer";
  $("search-view").hidden = view !== "search";
  if (view === "search") { $("search-input").focus(); $("search-input").select(); }
}
document.querySelectorAll(".activity[data-view]").forEach((b) => b.addEventListener("click", () => {
  const visible = !document.body.classList.contains("sidebar-hidden");
  if (visible && b.classList.contains("active")) toggleSidebar(false); else showView(b.dataset.view);
}));
document.querySelectorAll(".drawer-tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function toggleSidebar(force) {
  if (isNarrow()) return document.body.classList.contains("drawer-open") ? closeDrawer() : openDrawer();
  const show = force ?? document.body.classList.contains("sidebar-hidden");
  document.body.classList.toggle("sidebar-hidden", !show);
  updateSettings({ sidebarVisible: show });
}
function openDrawer() { document.body.classList.add("drawer-open"); }
function closeDrawer() { document.body.classList.remove("drawer-open"); }
$("drawer-button").addEventListener("click", () => toggleSidebar());
$("drawer-backdrop").addEventListener("click", closeDrawer);

function dragSash(sash, onMove, onDone) {
  sash.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sash.setPointerCapture(e.pointerId);
    sash.classList.add("dragging");
    const start = { x: e.clientX, y: e.clientY };
    onMove.begin?.();
    const move = (ev) => onMove(ev.clientX - start.x, ev.clientY - start.y);
    const up = () => { sash.classList.remove("dragging"); sash.removeEventListener("pointermove", move); sash.removeEventListener("pointerup", up); onDone(); };
    sash.addEventListener("pointermove", move);
    sash.addEventListener("pointerup", up);
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

// Keep the layout inside the visible area when the on-screen keyboard opens.
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
  document.documentElement.style.setProperty("--vvtop", `${vv.offsetTop}px`);
  state.activeTerm?.fit.fit();
}
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);

// ------------------------------------------------------------------ coding keys above the keyboard
const KEYS = [
  ["⇥", "tab"], ["←", "left"], ["↓", "down"], ["↑", "up"], ["→", "right"], ["↶", "undo"], ["↷", "redo"], ["^C", "ctrlc"],
  ..."{}()[]<>;:=\"'`/\\|&!+-*_#$%^~?@,.".split("").map((c) => [c, c]),
];
function buildKeybar() {
  const bar = $("keybar");
  for (const [label, key] of KEYS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.key = key;
    if (key === "ctrlc") b.classList.add("term-only");
    bar.appendChild(b);
  }
  // pointerdown + preventDefault keeps the editor focused, so the keyboard stays open.
  bar.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    e.preventDefault();
    pressKey(b.dataset.key);
  });
}
function pressKey(key) {
  if (lastFocus === "terminal" && state.activeTerm) {
    const seq = { tab: "\t", left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", ctrlc: "\x03", undo: "", redo: "" }[key];
    state.activeTerm.term.input(seq ?? key);
    return;
  }
  const view = editor();
  if (!view) return;
  const commands = { tab: indentMoreOrTab, left: cursorCharLeft, right: cursorCharRight, up: cursorLineUp, down: cursorLineDown, undo, redo };
  if (commands[key]) commands[key](view);
  else if (key !== "ctrlc") view.dispatch(view.state.replaceSelection(key));
}
function indentMoreOrTab(view) {
  if (view.state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  view.dispatch(view.state.replaceSelection(" ".repeat(Number(state.settings.tabSize))));
  return true;
}
function updateKeybar() {
  const touch = matchMedia("(pointer: coarse)").matches;
  const focusInside = document.activeElement?.closest?.(".cm-editor, #terminal-host");
  const show = touch && state.settings.keybar && Boolean(focusInside);
  $("keybar").hidden = !show;
  $("keybar").classList.toggle("for-terminal", lastFocus === "terminal");
  document.body.classList.toggle("keybar-open", show);
}
document.addEventListener("focusin", () => setTimeout(updateKeybar, 0));
document.addEventListener("focusout", () => setTimeout(updateKeybar, 50));

// ------------------------------------------------------------------ terminals (built-in JaniX shell on xterm.js)
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
    b.textContent = `${i + 1}: janix`;
    b.className = t === state.activeTerm ? "active" : "";
    b.addEventListener("click", () => showTerminal(t));
    box.appendChild(b);
  });
}

function showTerminal(t) {
  state.activeTerm = t;
  for (const other of state.terms) other.el.hidden = other !== t;
  renderTerminalTabs();
  requestAnimationFrame(() => { t.fit.fit(); if (!isNarrow()) t.term.focus(); });
}

async function newTerminal(cwd = state.root || vfs.PROJECTS) {
  await togglePanel(true, { skipCreate: true });
  const el = document.createElement("div");
  el.className = "term-instance";
  $("terminal-host").appendChild(el);
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace", fontSize: Number(state.settings.terminalFontSize) || 13,
    cursorBlink: true, scrollback: 5000, theme: terminalTheme(), convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
  term.open(el);
  fit.fit();
  term.textarea?.addEventListener("focus", () => { lastFocus = "terminal"; updateKeybar(); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey) return true;
    const key = e.key.toLowerCase();
    if (key === "c" && term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (key === "v") { navigator.clipboard?.readText().then((text) => term.paste(text)); return false; }
    if (key === "`" || key === "b" || key === "p" || key === ",") return false;
    return true;
  });
  const t = { term, fit, el, shell: null };
  t.shell = createShell({
    term, getCwd: () => cwd, setCwdHint: () => {}, getSettings: () => state.settings,
    app: {
      root: () => state.root, refresh: () => { state.fileIndex = null; refreshTree(); }, refreshGit: () => refreshGitSoon(),
      openFile: (p) => openFile(p), openFolder: (p) => switchProject(p), saveAll: () => saveAll({ onlyWithPath: true }),
      closeTerminal: () => killTerminal(t),
    },
  });
  state.terms.push(t);
  showTerminal(t);
  return t;
}

function killTerminal(t = state.activeTerm) {
  if (!t) return;
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
    if (isNarrow()) closeDrawer();
    if (!state.terms.length && !skipCreate) await newTerminal();
    else if (state.activeTerm) showTerminal(state.activeTerm);
  } else if (!isNarrow()) editor()?.focus();
}

new ResizeObserver(() => { if (state.activeTerm && !$("panel").hidden) state.activeTerm.fit.fit(); }).observe($("terminal-host"));
$("terminal-toggle").addEventListener("click", () => togglePanel());
$("terminal-close").addEventListener("click", () => togglePanel(false));
$("terminal-new").addEventListener("click", () => newTerminal());
$("terminal-kill").addEventListener("click", () => killTerminal());

// ------------------------------------------------------------------ status bar
function updateStatus() {
  const tab = activeTab();
  const view = editor();
  for (const id of ["status-position", "status-indent", "status-encoding", "status-eol", "status-language"]) $(id).hidden = !tab;
  if (!tab || !view) return;
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const selected = sel.empty ? "" : ` (${sel.to - sel.from} selected)`;
  $("status-position").textContent = `Ln ${line.number}, Col ${sel.head - line.from + 1}${selected}`;
  $("status-indent").textContent = `Spaces: ${state.settings.tabSize}`;
  $("status-eol").textContent = tab.eol === "\r\n" ? "CRLF" : "LF";
  $("status-language").textContent = tab.lang?.name || "Plain Text";
  $("save-button").classList.toggle("dirty", isDirty(tab));
}
$("status-position").addEventListener("click", () => { const v = editor(); if (v) { v.focus(); gotoLine(v); } });
$("status-language").addEventListener("click", () => showQuickOpen("languages"));
$("status-eol").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  tab.eol = tab.eol === "\r\n" ? "\n" : "\r\n";
  tab.savedDoc = Text.of([""]);     // line endings changed: the file needs saving
  renderTabs();
  updateStatus();
});
$("status-indent").addEventListener("click", () => {
  const order = [2, 4, 8];
  updateSettings({ tabSize: order[(order.indexOf(Number(state.settings.tabSize)) + 1) % order.length] });
  applyEditorSettings();
});

// ------------------------------------------------------------------ settings page
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = { "janix-light": "#f4f5f7", "hc-black": "#000000" }[theme] || "#16181d";
  for (const pane of panes) if (pane.view) reconfigure(pane.view);
  for (const t of state.terms) t.term.options.theme = terminalTheme();
  if (native) import("@capacitor/status-bar").then(({ StatusBar, Style }) => StatusBar.setStyle({ style: theme === "janix-light" ? Style.Light : Style.Dark })).catch(() => {});
}
function applyEditorSettings() {
  for (const pane of panes) if (pane.view) reconfigure(pane.view);
  for (const t of state.terms) { t.term.options.fontSize = Number(state.settings.terminalFontSize); t.fit.fit(); }
  updateKeybar();
  updateStatus();
}
function showSettings() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    const value = state.settings[input.dataset.setting];
    if (input.type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
  }
  $("settings").hidden = false;
}
for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", () => {
    const key = input.dataset.setting;
    let value = input.type === "checkbox" ? input.checked : input.value;
    if (["fontSize", "tabSize", "terminalFontSize"].includes(key)) {
      value = Number(value);
      if (!Number.isFinite(value) || value <= 0) return;
    }
    updateSettings({ [key]: typeof value === "string" ? value.trim() : value });
    if (key === "theme") applyTheme(value); else applyEditorSettings();
  });
}
$("settings-close").addEventListener("click", () => ($("settings").hidden = true));

addEventListener("blur", () => { if (state.settings?.autoSave === "onFocusChange") saveAll({ onlyWithPath: true }); });
document.addEventListener("visibilitychange", () => {
  // Phones close background apps without warning: never lose work when JaniX is hidden.
  if (document.hidden && state.settings.autoSave !== "off") saveAll({ onlyWithPath: true });
  if (document.hidden) saveSession();
});

// ------------------------------------------------------------------ menu (the phone version of the menu bar)
const COMMANDS = [
  ["New File", "newFile"], ["New Project…", "newProject"], ["Open Project…", "openFolderDialog"], ["Clone Git Repository…", "gitClone"],
  ["Import Files…", "importFiles"], ["Import ZIP…", "importZip"], ["Export Project as ZIP", "exportProject"], null,
  ["Save", "save"], ["Save As…", "saveAs"], ["Save All", "saveAll"], ["Close Editor", "closeTab"], ["Close Project", "closeFolder"], null,
  ["Undo", "editor", "undo"], ["Redo", "editor", "redo"], ["Find / Replace", "editor", "find"], ["Go to Line…", "editor", "gotoLine"],
  ["Toggle Comment", "editor", "comment"], ["Select All", "editor", "selectAll"], null,
  ["Command Palette…", "commandPalette"], ["Go to File…", "quickOpen"], ["Explorer", "showExplorer"], ["Search in Files", "showSearch"],
  ["Split Editor", "toggleSplit"], ["Markdown Preview", "markdownPreview"], ["Terminal", "toggleTerminal"], ["New Terminal", "newTerminal"],
  ["Toggle Word Wrap", "toggleWordWrap"], ["Change Language Mode…", "languageMode"], null,
  ["Theme: JaniX Dark", "setTheme", "janix-dark"], ["Theme: JaniX Light", "setTheme", "janix-light"], ["Theme: High Contrast", "setTheme", "hc-black"],
  ["Zoom In", "zoom", 1], ["Zoom Out", "zoom", -1], ["Reset Zoom", "zoom", 0], null,
  ["Settings", "openSettings"], ["About JaniX", "about"],
];
function showMenu() {
  const list = $("sheet-list");
  list.textContent = "";
  for (const item of COMMANDS) {
    if (!item) { list.appendChild(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.textContent = item[0];
    b.addEventListener("click", () => { $("sheet").hidden = true; runCommand(item[1], item[2]); });
    list.appendChild(b);
  }
  $("sheet").hidden = false;
}
$("menu-button").addEventListener("click", showMenu);
$("sheet").addEventListener("pointerdown", (e) => { if (e.target === $("sheet")) $("sheet").hidden = true; });
$("save-button").addEventListener("pointerdown", (e) => e.preventDefault());
$("save-button").addEventListener("click", () => runCommand("save"));

// ------------------------------------------------------------------ about, welcome
function renderWelcomeRecent() {
  const box = $("welcome-recent");
  box.textContent = "";
  const recent = state.settings.recentFolders || [];
  if (!recent.length) { box.innerHTML = `<span style="color:var(--fg-muted)">No recent projects</span>`; return; }
  for (const folder of recent.slice(0, 6)) {
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = basename(folder);
    b.title = folder;
    b.addEventListener("click", async () => { if (await vfs.isDir(folder)) switchProject(folder); else toast(`${basename(folder)} no longer exists.`, true); });
    box.appendChild(b);
  }
}
$("about-button").addEventListener("click", () => ($("about").hidden = false));
$("about-close").addEventListener("click", () => ($("about").hidden = true));
$("open-folder-button").addEventListener("click", () => showProjects());
document.querySelectorAll("#welcome [data-command]").forEach((b) => b.addEventListener("click", () => runCommand(b.dataset.command)));
for (const id of ["about", "settings", "projects"]) $(id).addEventListener("pointerdown", (e) => { if (e.target === $(id)) $(id).hidden = true; });

// ------------------------------------------------------------------ commands
async function runCommand(command, arg) {
  const tab = activeTab();
  switch (command) {
    case "newFile": return state.root ? createEntry(state.root, false) : newUntitled();
    case "newProject": return newProject();
    case "openFolderDialog": return showProjects();
    case "gitClone": return gitClone();
    case "importFiles": return importFiles();
    case "importZip": return importZip();
    case "exportProject": return exportProject();
    case "save": return tab ? saveTab(tab) : undefined;
    case "saveAs": return saveTab(tab, { saveAs: true });
    case "saveAll": return saveAll();
    case "closeTab": return tab && closeTab(tab.id);
    case "closeFolder": return closeFolder();
    case "quickOpen": return showQuickOpen("files");
    case "commandPalette": return showQuickOpen("commands");
    case "languageMode": return showQuickOpen("languages");
    case "showExplorer": return showView("explorer");
    case "showSearch": return showView("search");
    case "toggleSidebar": return toggleSidebar();
    case "toggleTerminal": return togglePanel();
    case "newTerminal": return newTerminal();
    case "toggleSplit": return toggleSplit();
    case "markdownPreview": return markdownPreview();
    case "openSettings": return showSettings();
    case "toggleWordWrap": updateSettings({ wordWrap: state.settings.wordWrap === "on" ? "off" : "on" }); return applyEditorSettings();
    case "setTheme": updateSettings({ theme: arg }); return applyTheme(arg);
    case "zoom": {
      const fontSize = arg === 0 ? 14 : Math.max(8, Math.min(40, Number(state.settings.fontSize) + arg));
      updateSettings({ fontSize });
      return applyEditorSettings();
    }
    case "about": $("about").hidden = false; return;
    case "editor": {
      const view = editor();
      if (!view || !tab) return;
      view.focus();
      const map = { undo, redo, find: openSearchPanel, gotoLine, comment: toggleComment, selectAll };
      return map[arg]?.(view);
    }
  }
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && e.key === "Tab") { e.preventDefault(); cycleTabs(e.shiftKey ? -1 : 1); }
  else if (mod && e.shiftKey && k === "p") { e.preventDefault(); showQuickOpen("commands"); }
  else if (mod && !e.shiftKey && k === "p") { e.preventDefault(); showQuickOpen("files"); }
  else if (mod && e.shiftKey && k === "f") { e.preventDefault(); showView("search"); }
  else if (mod && e.shiftKey && k === "e") { e.preventDefault(); showView("explorer"); }
  else if (mod && e.shiftKey && k === "v") { e.preventDefault(); markdownPreview(); }
  else if (mod && e.key === "`") { e.preventDefault(); togglePanel(); }
  else if (mod && e.key === "\\") { e.preventDefault(); toggleSplit(); }
  else if (mod && e.key === ",") { e.preventDefault(); showSettings(); }
  else if (mod && k === "s") { e.preventDefault(); runCommand(e.shiftKey ? "saveAs" : "save"); }
  else if (mod && k === "b") { e.preventDefault(); toggleSidebar(); }
  else if (e.key === "Escape") {
    for (const id of ["about", "settings", "projects", "sheet"]) if (!$(id).hidden) { $(id).hidden = true; return; }
    if (document.body.classList.contains("drawer-open")) closeDrawer();
  }
});

// Android back button: close the top-most thing instead of leaving the app.
if (native) {
  import("@capacitor/app").then(({ App }) => App.addListener("backButton", () => {
    for (const id of ["dialog", "quickopen", "about", "settings", "projects", "sheet"]) if (!$(id).hidden) { if (id !== "dialog") $(id).hidden = true; return; }
    if (!$("contextmenu").hidden) { $("contextmenu").hidden = true; return; }
    if (document.body.classList.contains("drawer-open")) return closeDrawer();
    if (rightMode) return closeRightPane();
    if (!$("panel").hidden) return togglePanel(false);
    saveAll({ onlyWithPath: true }).then(() => App.minimizeApp());
  })).catch(() => {});
}

addEventListener("beforeunload", (e) => {
  saveSession();
  if (state.tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ""; }
});

// ------------------------------------------------------------------ start-up
(async function start() {
  state.settings = loadSettings();
  document.body.classList.toggle("native", native);
  document.body.classList.toggle("touch", matchMedia("(pointer: coarse)").matches);
  fitViewport();
  createView(0);
  applyTheme(state.settings.theme);
  buildKeybar();
  if (!state.settings.sidebarVisible) document.body.classList.add("sidebar-hidden");
  if (state.settings.sidebarWidth && !isNarrow()) $("sidebar").style.width = `${state.settings.sidebarWidth}px`;
  if (state.settings.panelHeight && !isNarrow()) $("panel").style.height = `${state.settings.panelHeight}px`;
  $("about-version").textContent = `Version ${VERSION} · ${native ? (Capacitor.getPlatform() === "ios" ? "iPhone and iPad" : "Android") : "Web"}`;

  const sample = await guard(() => vfs.ensureSample());
  renderWelcomeRecent();
  renderTabs();
  updateStatus();

  const session = state.settings.session || {};
  const folder = sample || session.root || state.settings.lastFolder;
  if (folder && (await vfs.isDir(folder))) await openFolder(folder);
  if (sample) await openFile(join(sample, "README.md"));
  else if (session.files?.length) {
    for (const f of session.files) if (await vfs.exists(f)) await openFile(f);
    const active = state.tabs.find((t) => t.path === session.active);
    if (active) activateTab(active.id);
  }
  if (isNarrow()) closeDrawer();
  if ("serviceWorker" in navigator && !native && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();

// For debugging and automated tests.
Object.assign(window, { state, panes, runCommand, openFile, openFolder, switchProject, newTerminal, activeTab, isDirty, editor, vfs, toggleSplit, markdownPreview, closeRightPane });
