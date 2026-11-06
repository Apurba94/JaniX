// The JaniX Mobile terminal: phones do not allow a system shell, so this is a
// built-in shell over the project files, with git, and node/python runners.
import * as vfs from "./vfs.js";
import * as gitops from "./gitops.js";

const C = { dim: "\x1b[90m", accent: "\x1b[36m", err: "\x1b[31m", ok: "\x1b[32m", warn: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" };
const HELP = [
  ["ls [dir]", "list files"], ["cd <dir>", "change folder"], ["pwd", "print the current folder"],
  ["cat <file>", "print a file"], ["echo <text> [> file]", "print text, or write it to a file (>> appends)"],
  ["touch <file>", "create a file"], ["mkdir <dir>", "create a folder"], ["rm [-r] <path>", "delete"],
  ["mv <from> <to>", "move or rename"], ["cp [-r] <from> <to>", "copy"], ["open <file>", "open a file in the editor"],
  ["node <file.js> [< input]", "run JavaScript"], ["python <file.py> [< input]", "run Python (downloads Pyodide once)"],
  ["git <command>", "clone, init, status, add, commit, log, branch, checkout, pull, push"],
  ["projects", "list your projects"], ["clear", "clear the screen"], ["history", "show earlier commands"],
];

// Split a command line into words, honouring quotes.
function parse(line) {
  const words = [];
  let cur = "", quote = null, has = false;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) words.push(cur); cur = ""; has = false; }
    else cur += ch;
  }
  if (cur || has) words.push(cur);
  return words;
}

let runner = null;
let stopCurrent = null;
// Ctrl+C while a program runs: stop the worker (this also ends infinite loops).
function stopRunner() {
  if (!stopCurrent) return false;
  runner?.terminate();
  runner = null;
  stopCurrent();
  return true;
}
function getRunner() {
  if (!runner) runner = new Worker("runner.js");
  return runner;
}

function runCode(lang, code, stdin, out) {
  return new Promise((resolve) => {
    const worker = getRunner();
    const id = Math.random().toString(36).slice(2);
    const onMessage = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === "out") out(m.text, false);
      else if (m.type === "err") out(m.text, true);
      else if (m.type === "status") out(m.text, false, true);
      else if (m.type === "done") { worker.removeEventListener("message", onMessage); stopCurrent = null; resolve(m.ok); }
    };
    stopCurrent = () => { stopCurrent = null; out("^C\n", true); resolve(false); };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, lang, code, stdin });
  });
}

export function createShell({ term, getCwd, setCwdHint, getSettings, app }) {
  let cwd = getCwd() || vfs.PROJECTS;
  let line = "", cursor = 0, history = [], hIndex = 0, busy = false;
  const write = (s) => term.write(s.replace(/\r?\n/g, "\r\n"));
  const println = (s = "") => write(s + "\n");
  const prompt = () => {
    const short = cwd.startsWith(vfs.PROJECTS + "/") ? "~/" + cwd.slice(vfs.PROJECTS.length + 1) : cwd === vfs.PROJECTS ? "~" : cwd;
    write(`${C.accent}${short}${C.off} ${C.bold}$${C.off} `);
    line = ""; cursor = 0;
  };
  const redraw = () => { write("\x1b[2K\r"); prompt(); line = pending; cursor = pending.length; write(line); };
  let pending = "";

  async function exec(input) {
    let words = parse(input.trim());
    if (!words.length) return;
    // simple redirection: > file, >> file, < file
    let outFile = null, append = false, inFile = null;
    for (let i = 0; i < words.length; i++) {
      if ((words[i] === ">" || words[i] === ">>") && words[i + 1]) { outFile = words[i + 1]; append = words[i] === ">>"; words.splice(i, 2); i--; }
      else if (words[i] === "<" && words[i + 1]) { inFile = words[i + 1]; words.splice(i, 2); i--; }
    }
    const [cmd, ...args] = words;
    const p = (x) => vfs.resolvePath(cwd, x);
    let captured = "";
    const out = (s) => { if (outFile) captured += s + "\n"; else println(s); };
    switch (cmd) {
      case "help": for (const [c, d] of HELP) out(`  ${C.accent}${c.padEnd(26)}${C.off}${d}`); break;
      case "pwd": out(cwd); break;
      case "clear": case "cls": term.clear(); write("\x1b[2J\x1b[H"); break;
      case "history": history.forEach((h, i) => out(`${String(i + 1).padStart(4)}  ${h}`)); break;
      case "echo": out(args.join(" ")); break;
      case "whoami": out("janix"); break;
      case "date": out(new Date().toString()); break;
      case "projects": for (const name of await vfs.listProjects()) out(name); break;
      case "cd": {
        const target = args[0] ? p(args[0] === "~" ? vfs.PROJECTS : args[0]) : (app.root() || vfs.PROJECTS);
        if (!(await vfs.isDir(target))) throw new Error(`cd: no such folder: ${args[0]}`);
        cwd = target; setCwdHint(cwd); break;
      }
      case "ls": case "dir": {
        const target = p(args.find((a) => !a.startsWith("-")) || ".");
        if (!(await vfs.isDir(target))) { if (await vfs.exists(target)) { out(vfs.basename(target)); break; } throw new Error(`ls: no such file or folder: ${target}`); }
        const entries = await vfs.readDir(target);
        out(entries.map((e) => (e.isDir ? `${C.accent}${e.name}/${C.off}` : e.name)).join("  ") || `${C.dim}(empty)${C.off}`);
        break;
      }
      case "cat": case "type": for (const f of args) out(await vfs.readFile(p(f))); break;
      case "touch": for (const f of args) if (!(await vfs.exists(p(f)))) await vfs.writeFile(p(f), ""); app.refresh(); break;
      case "mkdir": for (const d of args.filter((a) => a !== "-p")) await vfs.mkdirp(p(d)); app.refresh(); break;
      case "rm": case "del": {
        const recursive = args.some((a) => /^-[a-z]*r/i.test(a));
        for (const f of args.filter((a) => !a.startsWith("-"))) {
          if ((await vfs.isDir(p(f))) && !recursive) throw new Error(`rm: ${f} is a folder (use rm -r)`);
          await vfs.remove(p(f));
        }
        app.refresh(); break;
      }
      case "mv": case "move": case "ren": {
        if (args.length !== 2) throw new Error("usage: mv <from> <to>");
        let to = p(args[1]);
        if (await vfs.isDir(to)) to = vfs.join(to, vfs.basename(p(args[0])));
        await vfs.rename(p(args[0]), to); app.refresh(); break;
      }
      case "cp": case "copy": {
        const files = args.filter((a) => !a.startsWith("-"));
        if (files.length !== 2) throw new Error("usage: cp [-r] <from> <to>");
        let to = p(files[1]);
        if (await vfs.isDir(to)) to = vfs.join(to, vfs.basename(p(files[0])));
        await vfs.copy(p(files[0]), to); app.refresh(); break;
      }
      case "open": case "code": case "janix": for (const f of args) await app.openFile(p(f)); break;
      case "node": case "js": case "python": case "python3": case "py": {
        const lang = cmd.startsWith("p") ? "python" : "js";
        if (!args[0]) throw new Error(`usage: ${cmd} <file>`);
        const code = await vfs.readFile(p(args[0]));
        const stdin = inFile ? await vfs.readFile(p(inFile)) : "";
        await app.saveAll();
        const ok = await runCode(lang, code, stdin, (text, isErr, isStatus) => {
          if (isStatus) println(`${C.dim}${text}${C.off}`);
          else if (outFile && !isErr) captured += text;
          else write(isErr ? `${C.err}${text}${C.off}` : text);
        });
        if (!ok) println(`${C.dim}[exited with an error]${C.off}`);
        break;
      }
      case "git": {
        const result = await gitops.run(args, { cwd, settings: getSettings(), print: out });
        if (args[0] === "clone" && result) { cwd = result; setCwdHint(cwd); app.openFolder(result); }
        app.refresh(); app.refreshGit();
        break;
      }
      case "exit": app.closeTerminal(); break;
      default: throw new Error(`${cmd}: command not found. Type 'help' for the list of commands.`);
    }
    if (outFile) { const f = p(outFile); const prev = append && (await vfs.exists(f)) ? await vfs.readFile(f) : ""; await vfs.writeFile(f, prev + captured); app.refresh(); }
  }

  async function submit() {
    const input = line;
    write("\r\n");
    if (input.trim()) { history.push(input); hIndex = history.length; }
    busy = true;
    try { await exec(input); }
    catch (error) { println(`${C.err}${error.message}${C.off}`); }
    busy = false;
    prompt();
  }

  function complete() {
    const words = line.slice(0, cursor).split(" ");
    const partial = words.pop();
    const dirPart = partial.includes("/") ? partial.slice(0, partial.lastIndexOf("/") + 1) : "";
    const base = partial.slice(dirPart.length);
    vfs.readDir(vfs.resolvePath(cwd, dirPart || ".")).then((entries) => {
      const hits = entries.filter((e) => e.name.startsWith(base));
      if (hits.length === 1) {
        const add = hits[0].name.slice(base.length) + (hits[0].isDir ? "/" : " ");
        line = line.slice(0, cursor) + add + line.slice(cursor);
        const c = cursor + add.length;
        pending = line; redraw(); moveCursorTo(c); cursor = c;
      } else if (hits.length > 1) {
        write("\r\n" + hits.map((e) => e.name + (e.isDir ? "/" : "")).join("  ") + "\r\n");
        const c = cursor;
        pending = line; redraw(); moveCursorTo(c); cursor = c;
      }
    }).catch(() => {});
  }
  function moveCursorTo(pos) { const back = line.length - pos; if (back > 0) write(`\x1b[${back}D`); }

  term.onData((data) => {
    if (busy) { if (data === "\x03") stopRunner(); return; }
    if (data === "\r") return void submit();
    if (data === "\x7f" || data === "\b") {
      if (cursor > 0) { line = line.slice(0, cursor - 1) + line.slice(cursor); cursor--; pending = line; const c = cursor; redraw(); moveCursorTo(c); cursor = c; }
      return;
    }
    if (data === "\x03") { write("^C\r\n"); prompt(); return; }
    if (data === "\x0c") { term.clear(); return; }
    if (data === "\t") return complete();
    if (data === "\x1b[A" || data === "\x1b[B") {
      if (!history.length) return;
      hIndex = Math.max(0, Math.min(history.length, hIndex + (data === "\x1b[A" ? -1 : 1)));
      pending = history[hIndex] || ""; redraw(); return;
    }
    if (data === "\x1b[D") { if (cursor > 0) { cursor--; write(data); } return; }
    if (data === "\x1b[C") { if (cursor < line.length) { cursor++; write(data); } return; }
    if (data.startsWith("\x1b")) return;
    // Typed or pasted text (a paste may contain several lines).
    const parts = data.replace(/\r\n/g, "\r").split(/[\r\n]/);
    parts.forEach((part, i) => {
      const clean = part.replace(/[\x00-\x1f]/g, "");
      line = line.slice(0, cursor) + clean + line.slice(cursor);
      cursor += clean.length;
      write(clean + line.slice(cursor) + (line.length > cursor ? `\x1b[${line.length - cursor}D` : ""));
      if (i < parts.length - 1) submit();
    });
  });

  println(`${C.bold}JaniX terminal${C.off} ${C.dim}— built-in shell. Type ${C.off}help${C.dim} for commands.${C.off}`);
  prompt();
  return {
    run: (cmd) => { line = cmd; write(cmd); submit(); },
    get cwd() { return cwd; },
  };
}
