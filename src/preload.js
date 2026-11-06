// The only bridge between the editor UI and the system: a fixed list of actions.
"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld("janix", {
  settings: { get: () => call("settings:get"), set: (patch) => call("settings:set", patch) },
  dialog: {
    openFolder: () => call("dialog:openFolder"),
    openFiles: () => call("dialog:openFiles"),
    saveAs: (suggested) => call("dialog:saveAs", suggested),
    confirm: (options) => call("dialog:confirm", options),
    error: (message) => call("dialog:prompt-error", message),
  },
  fs: {
    readDir: (dir) => call("fs:readDir", dir),
    listFiles: (root) => call("fs:listFiles", root),
    search: (root, query, options) => call("fs:search", root, query, options),
    readFile: (file) => call("fs:readFile", file),
    writeFile: (file, text) => call("fs:writeFile", file, text),
    createFile: (file) => call("fs:createFile", file),
    createFolder: (dir) => call("fs:createFolder", dir),
    rename: (from, to) => call("fs:rename", from, to),
    trash: (target) => call("fs:trash", target),
    reveal: (target) => call("fs:reveal", target),
    exists: (target) => call("fs:exists", target),
  },
  terminal: {
    start: (options) => call("term:start", options),
    resize: (id, cols, rows) => call("term:resize", id, cols, rows),
    write: (id, data) => call("term:write", id, data),
    kill: (id) => call("term:kill", id),
    onData: (fn) => ipcRenderer.on("term:data", (_e, id, data) => fn(id, data)),
    onExit: (fn) => ipcRenderer.on("term:exit", (_e, id, code) => fn(id, code)),
  },
  git: { status: (root) => call("git:status", root) },
  app: {
    launchTarget: () => call("app:launchTarget"),
    onMenu: (fn) => ipcRenderer.on("menu", (_e, command, ...args) => fn(command, ...args)),
    onRequestClose: (fn) => ipcRenderer.on("app:request-close", () => fn()),
    confirmClose: () => ipcRenderer.send("app:close-confirmed"),
  },
  // Paths of files dropped onto the window.
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
  pathSep: process.platform === "win32" ? "\\" : "/",
});
