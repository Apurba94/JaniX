// Git for JaniX Mobile, through isomorphic-git on the in-browser file system.
// Git hosts do not allow cross-origin requests, so network calls go through
// JaniX's own small proxy (api/git-proxy on the JaniX web app).
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { lfs as fs, join, exists, dirname } from "./vfs.js";

const WEB_ORIGIN = "https://janix-editor.vercel.app";
const corsProxy = () => (location.protocol === "https:" && location.hostname.endsWith("vercel.app") ? location.origin : WEB_ORIGIN) + "/api/git-proxy";

export async function findRoot(dir) {
  let cur = dir;
  while (cur && cur !== "/") {
    if (await exists(join(cur, ".git"))) return cur;
    cur = dirname(cur);
  }
  return null;
}

// Same shape as the desktop app: { branch, files: { absolutePath: status } }, or null.
export async function status(dir) {
  const root = await findRoot(dir);
  if (!root) return null;
  const branch = (await git.currentBranch({ fs, dir: root, fullname: false }).catch(() => null)) || "(detached)";
  const files = {};
  const matrix = await git.statusMatrix({ fs, dir: root });
  for (const [file, head, work, stage] of matrix) {
    let s = null;
    if (head === 0 && work === 2) s = stage === 0 ? "untracked" : "added";
    else if (head === 1 && work === 0) s = "deleted";
    else if (head === 1 && (work === 2 || stage !== 1)) s = "modified";
    else if (head === 0 && work === 0 && stage !== 0) s = "deleted";
    if (s) files[join(root, file)] = s;
  }
  return { branch, files, root };
}

const authFor = (settings) => (settings.gitToken ? () => ({ username: settings.gitToken, password: "x-oauth-basic" }) : undefined);
const author = (settings) => ({ name: settings.gitName || "JaniX user", email: settings.gitEmail || "janix@example.invalid" });

export async function clone({ url, dir, settings, onMessage }) {
  await git.clone({
    fs, http, dir, url, corsProxy: corsProxy(), singleBranch: true, depth: 50,
    onAuth: authFor(settings),
    onProgress: (p) => onMessage?.(`${p.phase}${p.total ? ` ${Math.round((p.loaded / p.total) * 100)}%` : ` ${p.loaded}`}`),
  });
}

export async function run(args, { cwd, settings, print }) {
  const dir = await findRoot(cwd);
  const sub = args[0];
  if (!sub || sub === "help") {
    print("git commands: clone <url> [dir], init, status, add <path|.>, commit -m <message>, log, branch [name], checkout <branch>, pull, push, diff --stat, remote -v");
    return;
  }
  if (sub === "clone") {
    const url = args[1];
    if (!url) throw new Error("usage: git clone <url> [folder]");
    const name = args[2] || url.replace(/\.git$/, "").split("/").pop();
    const target = name.startsWith("/") ? name : join(cwd, name);
    if (await exists(target)) throw new Error(`${target} already exists.`);
    let last = "";
    await clone({ url, dir: target, settings, onMessage: (m) => { if (m.split(" ")[0] !== last.split(" ")[0]) print(m); last = m; } });
    print(`Cloned into ${target}`);
    return target;
  }
  if (sub === "init") {
    await git.init({ fs, dir: cwd, defaultBranch: "main" });
    print(`Initialized empty Git repository in ${cwd}/.git`);
    return;
  }
  if (!dir) throw new Error("not a git repository (run `git init` or `git clone <url>`)");
  switch (sub) {
    case "status": {
      const st = await status(dir);
      print(`On branch ${st.branch}`);
      const entries = Object.entries(st.files);
      if (!entries.length) print("nothing to commit, working tree clean");
      for (const [file, s] of entries) print(`  ${s.padEnd(10)} ${file.slice(dir.length + 1)}`);
      return;
    }
    case "add": {
      const paths = args.slice(1);
      if (!paths.length) throw new Error("usage: git add <path> | git add .");
      const matrix = await git.statusMatrix({ fs, dir });
      for (const [file, , work] of matrix) {
        const rel = file;
        const wanted = paths.some((p) => p === "." || p === "-A" || rel === p || rel.startsWith(p.replace(/\/$/, "") + "/"));
        if (!wanted) continue;
        if (work === 0) await git.remove({ fs, dir, filepath: rel }); else await git.add({ fs, dir, filepath: rel });
      }
      return;
    }
    case "commit": {
      const i = args.indexOf("-m");
      const message = i >= 0 ? args.slice(i + 1).join(" ") : "";
      if (!message) throw new Error('usage: git commit -m "message"');
      if (args.includes("-a") || args.includes("-am")) await run(["add", "."], { cwd, settings, print });
      const sha = await git.commit({ fs, dir, message, author: author(settings) });
      print(`[${await git.currentBranch({ fs, dir })} ${sha.slice(0, 7)}] ${message}`);
      return;
    }
    case "log": {
      const commits = await git.log({ fs, dir, depth: 20 });
      for (const c of commits) {
        const d = new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
        print(`\x1b[33m${c.oid.slice(0, 7)}\x1b[0m ${d} ${c.commit.author.name}: ${c.commit.message.split("\n")[0]}`);
      }
      return;
    }
    case "branch": {
      if (args[1]) { await git.branch({ fs, dir, ref: args[1] }); print(`Created branch ${args[1]}`); return; }
      const current = await git.currentBranch({ fs, dir });
      for (const b of await git.listBranches({ fs, dir })) print(`${b === current ? "* " : "  "}${b}`);
      return;
    }
    case "checkout": {
      if (!args[1]) throw new Error("usage: git checkout <branch>");
      await git.checkout({ fs, dir, ref: args[1] });
      print(`Switched to branch '${args[1]}'`);
      return;
    }
    case "pull": {
      await git.pull({ fs, http, dir, corsProxy: corsProxy(), singleBranch: true, author: author(settings), onAuth: authFor(settings) });
      print("Pulled the latest changes.");
      return;
    }
    case "push": {
      if (!settings.gitToken) throw new Error("Pushing needs a GitHub personal access token: add it in Settings → Git.");
      const r = await git.push({ fs, http, dir, corsProxy: corsProxy(), onAuth: authFor(settings) });
      print(r.ok ? "Pushed." : `Push failed: ${JSON.stringify(r.refs)}`);
      return;
    }
    case "remote": {
      for (const r of await git.listRemotes({ fs, dir })) print(`${r.remote}\t${r.url}`);
      return;
    }
    case "diff": {
      const st = await status(dir);
      for (const [file, s] of Object.entries(st.files)) print(`${s[0].toUpperCase()} ${file.slice(dir.length + 1)}`);
      return;
    }
    default:
      throw new Error(`git: '${sub}' is not supported in JaniX Mobile. Try 'git help'.`);
  }
}
