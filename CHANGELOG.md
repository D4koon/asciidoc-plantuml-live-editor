# Changelog

## Unreleased

### Preview

- AsciiDoc `include::` with `lines=`, `tags=` or `tag=` shows unsaved edits
  of the included file, and in a diff the old side selects from the same git
  version. The selection follows Asciidoctor's rules exactly. Clicking and
  editing selected content goes to the right line of the included file.
- Warnings: what Asciidoctor reports while rendering (e.g. a tag an include
  asks for that the file doesn't have) is listed in a collapsed box above the
  document. A problem with an include's `lines=` or `tags=` also shows in
  place of the include. Click a warning to go to its line.

### Diffs

- Within a changed paragraph, the words that changed are marked.
- A line separates the two sides.

## 1.0.0

First release.

### Preview

- PlantUML files (`.puml`, `.plantuml`, `.pu`, `.iuml`, `.wsd`) and AsciiDoc
  documents (`.adoc`, `.asciidoc`, `.asc`) open rendered, and update as you type.
- Everything is rendered inside VS Code with PlantUML's in-browser engine and
  Asciidoctor.js: no Java, no Graphviz, no server, nothing leaves your machine.
- AsciiDoc: `[plantuml]` blocks and `plantuml::file[]` macros are drawn in
  place, as with Asciidoctor Diagram. `include::`, block titles, IDs and
  cross-references work.
- PlantUML: local `!include` chains (relative paths, `!include_once`,
  `!include_many`, `file!id` selectors) and the bundled standard library
  (`<C4/...>`, `<awslib/...>`, …).
- Light and dark diagrams following the VS Code theme, zoom, export to SVG.

### Editing

- **Split** view: the source in an editor next to the preview, in the same tab.
- Edit the preview directly: rename participants, classes, labels and
  members; delete messages and relations; edit AsciiDoc headings,
  paragraphs, list items, admonitions and code blocks in place.
- Changes go to the file the content came from, also included chapters and
  `!include`d files.
- Clicking content selects its source line, switching the editor to the
  included file it comes from.
- An overview of includes, as a tree, to move between the files of a
  document.

### AsciiDoc in the text editor

- Syntax highlighting, with PlantUML highlighting inside `[plantuml]` blocks.
- <kbd>Ctrl</kbd>+<kbd>/</kbd> comments, bracket pairing, and folding of
  sections and delimited blocks.

### Diffs

- Diffs of PlantUML and AsciiDoc files, e.g. from Source Control, show both
  versions rendered side by side. The old side reads its includes from the
  same git version.
- Changes are highlighted: removed in red on the left, added in green on the
  right, down to single diagram elements. Arrows and <kbd>F7</kbd> jump
  between changes.
- Both sides scroll together, by content.
