// JaniX Mobile code runner (a Web Worker): runs JavaScript, or Python through
// Pyodide, and streams the output back to the terminal.
"use strict";
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
let pyodide = null;

function format(value) {
  if (typeof value === "string") return value;
  try { return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value); } catch { return String(value); }
}

async function runJs(id, code, stdin) {
  const send = (type, text) => postMessage({ id, type, text });
  const fake = {
    log: (...a) => send("out", a.map(format).join(" ") + "\n"),
    info: (...a) => send("out", a.map(format).join(" ") + "\n"),
    warn: (...a) => send("err", a.map(format).join(" ") + "\n"),
    error: (...a) => send("err", a.map(format).join(" ") + "\n"),
  };
  const lines = stdin.split(/\r?\n/);
  let next = 0;
  const readline = () => (next < lines.length ? lines[next++] : null);
  // The program sees console, the whole input as `input`, and readline() for one line at a time.
  const fn = new Function("console", "input", "readline", `"use strict";\nreturn (async () => {\n${code}\n})();`);
  await fn(fake, stdin, readline);
}

async function runPython(id, code, stdin) {
  const send = (type, text) => postMessage({ id, type, text });
  if (!pyodide) {
    send("status", "Loading Python (first run downloads about 10 MB)…");
    importScripts(PYODIDE + "pyodide.js");
    pyodide = await self.loadPyodide({ indexURL: PYODIDE });
  }
  pyodide.setStdout({ batched: (s) => send("out", s + "\n") });
  pyodide.setStderr({ batched: (s) => send("err", s + "\n") });
  const lines = stdin.split(/\r?\n/);
  let next = 0;
  pyodide.setStdin({ stdin: () => (next < lines.length ? lines[next++] : undefined) });
  await pyodide.loadPackagesFromImports(code).catch(() => {});
  await pyodide.runPythonAsync(code);
}

self.onmessage = async (e) => {
  const { id, lang, code, stdin } = e.data;
  try {
    if (lang === "python") await runPython(id, code, stdin || ""); else await runJs(id, code, stdin || "");
    postMessage({ id, type: "done", ok: true });
  } catch (error) {
    postMessage({ id, type: "err", text: (error && (error.stack || error.message)) + "\n" });
    postMessage({ id, type: "done", ok: false });
  }
};
