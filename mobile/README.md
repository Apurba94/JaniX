# JaniX for Android and iPhone

The same JaniX editor as on Windows, for phones and tablets, by **Janin A Apurba**.
It ships as one code base, in three forms:

| Platform | How to get it |
|---|---|
| **Any phone or computer** (web app) | Open **https://janix-editor.vercel.app**, then choose *Add to Home Screen* (iPhone: Share → Add to Home Screen; Android: ⋮ → Install app). It works offline once opened. |
| **Android** | Download **JaniX-1.1.0.apk** from the [Releases page](https://github.com/Apurba94/JaniX/releases/latest), open it, and allow installing from this source. |
| **iPhone / iPad** | Use the web app above. The native iOS project in `ios/` builds in Xcode; installing it on an iPhone needs an Apple Developer account to sign it. |

## Features (same as JaniX for Windows)

- **Editor**
  - Syntax highlighting for 140+ languages, with autocomplete and bracket matching.
  - Multi-cursor editing, find and replace, go to line, code folding and toggle comment.
- **Tabs** with unsaved-change markers, plus **Go to File** and a **Command Palette**.
- **Search in Files.**
- **Explorer**: new, rename, duplicate and delete. On touch screens, the `⋯` button on each row stands in for right-click.
- **Split editor** (stacked on phones) and a live **Markdown preview**.
- **Terminal**: a built-in shell with `ls cd cat echo mkdir touch rm mv cp`, plus:
  - **`node file.js`** and **`python file.py`** (Python runs in Pyodide), with `< input.txt`.
  - **Git**: `clone`, `init`, `status`, `add`, `commit`, `log`, `branch`, `checkout`, `pull` and `push`.
- **Git status colours** in the explorer, and the current branch in the status bar.
- **Settings**:
  - Theme, font, tab size, word wrap, line numbers, whitespace and cursor.
  - Auto save.
  - Your Git name and email, and a GitHub token for push.
- **Phone-friendly controls**
  - A row of **coding keys** above the keyboard (Tab, arrows, brackets, symbols, undo and redo).
  - A drawer explorer, and a ⋮ menu that holds every command.
  - The Android back button.
- **Projects**
  - Kept on the device.
  - Import files or a ZIP, clone from GitHub, and export a project as a ZIP through the share sheet.
- **Themes**: JaniX Dark, JaniX Light and High Contrast.

Phones do not allow apps to run a system shell, so the terminal is JaniX's own shell rather than PowerShell or bash.

## Build

Requires Node.js 20+.

```bash
npm install
node build.mjs          # builds the web app into www/
node serve.mjs          # serves www/ on http://localhost:5174
npx cap sync android    # copies www/ into the Android project (open android/ in Android Studio)
npx cap sync ios        # copies www/ into the iOS project (open ios/App in Xcode, on a Mac)
```

**Automated builds.** The `JaniX Mobile` GitHub Actions workflow builds the Android APK and checks that the iOS app compiles.

**Android signing.** Debug builds are signed with `android/app/janix-debug.p12`, a debug key with the public password `android`. This makes each new APK install over the previous one. For Google Play, sign with your own private upload key.

**Git proxy.** Browsers cannot contact Git hosts directly, so `api/git-proxy` on the web app forwards Git requests. It forwards only Git smart-HTTP requests to GitHub, GitLab, Bitbucket and Codeberg, and stores nothing.

## Credits

Created by **Janin A Apurba**. MIT License.

JaniX Mobile builds on these open-source projects:

- CodeMirror, xterm.js, isomorphic-git, marked, JSZip and Capacitor (MIT)
- DOMPurify (Apache-2.0 / MPL-2.0)
- Pyodide (MPL-2.0)

## Follow Janin on YouTube

- **Study with Janin**: [youtube.com/@studywithjanin](https://www.youtube.com/@studywithjanin)
- **Pomodoro Study with Janin**: [youtube.com/@pomodorostudywithjanin3326](https://www.youtube.com/@pomodorostudywithjanin3326)
