// CodeMirror 6 set-up for JaniX Mobile: the JaniX themes, the editor options
// from Settings, and languages loaded on demand from the file name.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars, highlightWhitespace, highlightTrailingWhitespace } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle, bracketMatching, foldKeymap, indentUnit, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

export { EditorView, EditorState, languages, LanguageDescription };

const palettes = {
  "janix-dark": { bg: "#16181d", fg: "#d6dae2", gutter: "#4b5262", gutterActive: "#c7cbd3", line: "#1f232b", sel: "#2c3a52", cursor: "#36c6c0",
    comment: "#6a7385", keyword: "#c792ea", string: "#a5d6a7", number: "#f78c6c", type: "#36c6c0", fn: "#82aaff", prop: "#d6dae2", tag: "#f07178", attr: "#ffcb6b", panel: "#1f232b", dark: true },
  "janix-light": { bg: "#ffffff", fg: "#23262d", gutter: "#9aa0a6", gutterActive: "#23262d", line: "#f3f5f8", sel: "#cfe8e7", cursor: "#128c87",
    comment: "#7a8394", keyword: "#8b2fc9", string: "#1a7f37", number: "#b5561c", type: "#0e7672", fn: "#2955c2", prop: "#23262d", tag: "#c93c3c", attr: "#9a6700", panel: "#f4f5f7", dark: false },
  "hc-black": { bg: "#000000", fg: "#ffffff", gutter: "#d0d0d0", gutterActive: "#ffffff", line: "#1a1a1a", sel: "#003b3a", cursor: "#6fe0db",
    comment: "#7ca668", keyword: "#c586c0", string: "#ce9178", number: "#b5cea8", type: "#4ec9b0", fn: "#dcdcaa", prop: "#9cdcfe", tag: "#569cd6", attr: "#9cdcfe", panel: "#000000", dark: true },
};

export function themeExtension(name, { fontSize, fontFamily, cursorStyle }) {
  const p = palettes[name] || palettes["janix-dark"];
  const cursor = cursorStyle === "block" ? { borderLeft: `0.55em solid ${p.cursor}`, opacity: 0.6 }
    : cursorStyle === "underline" ? { borderLeft: "none", borderBottom: `2px solid ${p.cursor}`, width: "0.6em" } : { borderLeftColor: p.cursor, borderLeftWidth: "2px" };
  const theme = EditorView.theme({
    "&": { color: p.fg, backgroundColor: p.bg, height: "100%", fontSize: `${fontSize}px` },
    ".cm-scroller": { fontFamily, lineHeight: "1.55" },
    ".cm-content": { caretColor: p.cursor, paddingBottom: "40vh" },
    ".cm-cursor, .cm-dropCursor": cursor,
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: p.sel },
    ".cm-activeLine": { backgroundColor: p.line },
    ".cm-activeLineGutter": { backgroundColor: p.line, color: p.gutterActive },
    ".cm-gutters": { backgroundColor: p.bg, color: p.gutter, border: "none" },
    ".cm-foldPlaceholder": { backgroundColor: p.line, border: "none", color: p.gutter },
    ".cm-panels": { backgroundColor: p.panel, color: p.fg },
    ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${p.line}` },
    ".cm-searchMatch": { backgroundColor: "rgba(230, 180, 80, .3)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(54, 198, 192, .35)" },
    ".cm-selectionMatch": { backgroundColor: p.dark ? "#2a3446" : "#e0eceb" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: p.dark ? "#2f3d3c" : "#d4efed", outline: `1px solid ${p.cursor}` },
    ".cm-tooltip": { backgroundColor: p.panel, border: `1px solid ${p.line}`, color: p.fg },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: p.sel, color: p.fg },
  }, { dark: p.dark });
  const style = HighlightStyle.define([
    { tag: t.comment, color: p.comment, fontStyle: "italic" },
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
    { tag: [t.number, t.bool, t.null, t.atom], color: p.number },
    { tag: [t.typeName, t.className, t.namespace], color: p.type },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.fn },
    { tag: t.propertyName, color: p.prop },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.attr },
    { tag: t.heading, color: p.tag, fontWeight: "bold" },
    { tag: t.strong, fontWeight: "bold" }, { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, color: p.fn, textDecoration: "underline" },
    { tag: t.invalid, color: "#ef6b6b" },
  ]);
  return [theme, syntaxHighlighting(style)];
}

export function optionsExtension(s) {
  const ext = [EditorState.tabSize.of(Number(s.tabSize)), indentUnit.of(" ".repeat(Number(s.tabSize)))];
  if (s.wordWrap === "on") ext.push(EditorView.lineWrapping);
  if (s.lineNumbers !== "off") ext.push(lineNumbers(), highlightActiveLineGutter(), foldGutter());
  if (s.renderWhitespace === "all") ext.push(highlightWhitespace());
  if (s.renderWhitespace !== "none") ext.push(highlightTrailingWhitespace());
  return ext;
}

// One compartment set per editor state, so settings and language can change live.
export function makeCompartments() {
  return { theme: new Compartment(), options: new Compartment(), language: new Compartment() };
}

export function baseExtensions({ compartments, settings, onUpdate, onSave }) {
  return [
    highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
    indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => { onSave(); return true; } },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
    ]),
    compartments.theme.of(themeExtension(settings.theme, settings)),
    compartments.options.of(optionsExtension(settings)),
    EditorView.updateListener.of(onUpdate),
    EditorView.contentAttributes.of({ autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
  ];
}

export function languageFor(filename) {
  return LanguageDescription.matchFilename(languages, filename);
}
