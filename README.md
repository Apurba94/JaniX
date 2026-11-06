# JaniX

A fast code editor for Windows, built on Monaco, the editor component that powers VS Code.

## Download

Get the latest version from the [Releases page](https://github.com/Apurba94/JaniX/releases/latest):

- **JaniX-Setup-1.1.0.exe** (installer). Adds Start-menu and desktop shortcuts, plus **Open with JaniX** to the Explorer right-click menu for files and folders. It installs for the current user, so no administrator rights are needed.
- **JaniX.exe** (portable). A single file that runs without installing.

The `.exe` files are not code-signed, so Windows SmartScreen may warn on first launch. Choose "More info", then "Run anyway".

## Features

- **Editing**
  - Syntax highlighting, IntelliSense-style suggestions and error checking for 80+ languages.
  - Multi-cursor editing, find and replace, minimap, bracket colouring and sticky scroll.
  - Command palette (`Ctrl+Shift+P`).
- **Split editor** (`Ctrl+\`): two files, or two views of one file, side by side.
- **Markdown preview** (`Ctrl+Shift+V`): a live preview to the side, with highlighted code blocks.
- **Integrated terminal** (`` Ctrl+` ``)
  - A real terminal (ConPTY + xterm.js) that runs PowerShell, cmd, Git Bash or WSL.
  - Multiple terminal tabs, clickable links, and copy/paste with `Ctrl+C` / `Ctrl+V`.
- **Git integration**
  - Changed, untracked and conflicted files are coloured in the explorer.
  - The status bar shows the current branch.
- **File explorer**
  - New, rename and delete (to the Recycle Bin).
  - Drag and drop to open, and "Open in Integrated Terminal".
- **Go to File** (`Ctrl+P`) with fuzzy matching, and **Find in Files** (`Ctrl+Shift+F`).
- **Settings** (`Ctrl+,`)
  - Theme, font, tab size, word wrap, line numbers, whitespace, cursor style and minimap.
  - Auto save (after a delay, or when the window loses focus).
  - Terminal shell and terminal font size.
- **Themes and sessions**
  - JaniX Dark, JaniX Light and High Contrast themes.
  - Restores your last folder and open files.

## Build from source

Requires Node.js 20+.

```bash
npm install
npm start            # run in development
npm run dist         # dist/JaniX.exe (portable, single file)
npm run dist:setup   # dist/JaniX-Setup-<version>.exe (installer)
```

## Credits

Created by **Janin A Apurba**. Released under the [MIT License](LICENSE).

JaniX builds on these open-source projects, each under the MIT License:

- Monaco Editor (© Microsoft)
- xterm.js
- node-pty
- marked
- DOMPurify (Apache-2.0 / MPL-2.0)

## Follow Janin on YouTube

If this project helped you, please follow and subscribe:

- **Study with Janin**: [youtube.com/@studywithjanin](https://www.youtube.com/@studywithjanin)
- **Pomodoro Study with Janin**: [youtube.com/@pomodorostudywithjanin3326](https://www.youtube.com/@pomodorostudywithjanin3326)
