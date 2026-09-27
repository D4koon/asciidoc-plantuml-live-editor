# AsciiDoc & PlantUML Live Editor

Live preview and visual editing of AsciiDoc documents and PlantUML diagrams in
VS Code. Edit the text or the rendered view, follow includes across files, and
see changes side by side in diffs. Rendering happens entirely in the preview
using PlantUML's in-browser engine and Asciidoctor.js: **no Java, no Graphviz
install, no PlantUML server, and your documents never leave your machine.**

## About the engine

This extension was meant to be built on
[plantuml/plantuml-core](https://github.com/plantuml/plantuml-core) (PlantUML compiled
to JavaScript with CheerpJ). That project is now **discontinued**. Its README points
to the official replacement,
[js-plantuml](https://plantuml.github.io/plantuml/js-plantuml/index.html): PlantUML
compiled to native JavaScript with TeaVM, with layout by Viz.js (Graphviz as
WebAssembly).

Every [PlantUML release](https://github.com/plantuml/plantuml/releases) ships this
build as `js-plantuml-<version>.zip`. The extension pins a release in `package.json`:

```json
"plantumlJs": { "version": "1.2026.9" }
```

`npm run fetch-runtime` downloads that zip and extracts the runtime files into
`media/vendor/`. That folder is git-ignored and gets a `VERSION.json` recording the
source URL and SHA-256:

| File | Purpose |
|------|---------|
| `plantuml.js` | PlantUML engine (ES module exporting `render` / `renderToString`) |
| `viz-global.js` | Viz.js 3.x, used by PlantUML for Graphviz-based layouts |
| `themes.js` | `!theme` definitions |
| `emoji.js`, `openiconic.js` | `<:emoji:>` and `<&icon>` support |
| `*.min.js` | Standard library (`!include <C4/...>`, `<awslib/...>`, …) |

The engine loads the extra files on demand, so everything works offline.

To change the engine version:

```sh
npm run fetch-runtime -- 1.2026.8     # one-off: a specific release
npm run fetch-runtime -- snapshot     # one-off: the rolling snapshot build
```

To change the version permanently, edit `plantumlJs.version`. The script skips
the download when the pinned version is already present. Pass `--force` to
download again.

## Features

- **Opens as a diagram**: clicking a PlantUML file opens the rendered preview.
  **Edit Source** (toolbar button, title-bar icon, or double-click) opens the
  text editor beside it. The preview stays open and updates as you type.
  <kbd>Alt</kbd>+click the title-bar icon to swap the tab to the text editor in
  place instead; **Show Preview** in the text editor's title bar swaps back.
  Unsaved edits are kept either way. To open files as text by default instead, add
  `"workbench.editorAssociations": { "*.puml": "default" }` (or `"*.adoc"`) to your settings.
- **Split view in one tab**: the **Split** toolbar button shows an embedded
  editor (Monaco) next to the diagram, with a draggable divider. Edits go
  straight to the file, so saving, the dirty marker and any open VS Code editor
  for the file stay in sync. The extension remembers your choice for the next
  file you open. The embedded editor doesn't use your VS Code keybindings,
  settings or other extensions; use **Edit Source** for the full editor.
- **Overview of includes**: under the split view's editor, a collapsible
  *Includes* panel lists everything the file pulls in, as a tree: `!include`
  directives (and the ones inside the included files), and for AsciiDoc also
  `include::` directives, `plantuml::` macros and the includes of diagrams in
  included chapters. The file of the tab is the first entry.
  - *Click a file name* to show that file in this tab: its text in the split
    editor, where you can edit it, and its preview beside it. The tab stays
    on its own file, and breadcrumbs in the toolbar lead back
    (`manual.adoc › 02-architecture.adoc`). Click the line number to show the
    file containing the directive, with the directive selected.
  - A file that doesn't render on its own (e.g. `colors.iuml`, only
    `skinparam`s) keeps the tab's preview, which updates as you type, so you
    see the effect on the real diagrams.
  - Edits to included files show in the preview before they are saved.
    <kbd>Ctrl</kbd>+<kbd>S</kbd> saves the file shown in the editor. Unsaved
    files get a dot in the overview. If you close the tab with unsaved
    included files that aren't open elsewhere, you are offered to save them.
    AsciiDoc includes using `lines=` or `tag=` show the saved text.

  Entries that were not used are marked: *not found*,
  *already included* (`!include_once`), *recursive*, or *outside the document
  folder* (AsciiDoc safe mode). AsciiDoc conditionals (`ifdef::`) are not
  evaluated, so the overview lists includes from every branch.
- **Edit the diagram directly**:
  - *Click* an element to select it. Its source line is highlighted in the split
    editor and in any open text editor for the file.
  - *Double-click* a text to rename it in place: participant and class names,
    message and relationship labels, multiplicities, class members, and activity
    texts. Renaming an identifier (e.g. `class Order`) updates every reference in
    that diagram. Renaming a display name (`participant "Web App" as App`) changes
    only the label.
  - *Delete* removes a selected message or relationship line.

  Layout can't be edited: PlantUML positions everything automatically. Text that
  can't be traced back to the source (e.g. generated by `!define` or formatted with
  creole markup) shows a message instead, so you can edit it as text.
- **Side-by-side preview** for editing with live updates: `AsciiDoc & PlantUML: Open Preview
  to the Side` (<kbd>Alt</kbd>+<kbd>D</kbd>), or <kbd>Alt</kbd>+click the title-bar
  button.
- **Live update** while you type, debounced by `asciidocPlantumlLive.renderDelay`.
- **Multiple diagrams per file**: each `@startuml … @enduml` block (or any
  `@startXXX` / `@endXXX` pair) renders separately.
- **Local `!include`**: the engine cannot read files, so the extension inlines
  them first. Supports relative paths, `!include_once`, `!include_many`, and
  `file.puml!N` / `file.puml!id` selectors. Standard-library includes
  (`!include <C4/C4_Container>`) come from the bundled stdlib.
- **Theme aware**: diagrams use PlantUML's dark rendering when VS Code uses a dark
  theme. You can override this with `asciidocPlantumlLive.theme`.
- **Zoom**: use the toolbar buttons, <kbd>Ctrl</kbd>+scroll, or *Fit* to fit the
  width.
- **AsciiDoc preview**: `.adoc`, `.asciidoc` and `.asc` files open rendered,
  just like PlantUML files, with the same **Split** and **Edit Source** buttons
  (the split editor highlights AsciiDoc and wraps long lines).
  `AsciiDoc & PlantUML: Open Preview to the Side` (<kbd>Alt</kbd>+<kbd>D</kbd>) works from the
  text editor as well. The whole document is rendered with
  [Asciidoctor.js](https://github.com/asciidoctor/asciidoctor.js), with diagrams
  drawn in place:
  - `[plantuml]` blocks (`----` or `....` delimited, `@startuml` optional) and
    `plantuml::file.puml[]` macros, as with Asciidoctor Diagram.
  - Block titles (`.Title`) and IDs work, so `<<id>>` cross-references link to diagrams.
  - `include::` works. By default only files inside the document's folder can be
    included; set `asciidocPlantumlLive.asciidoc.safeMode` to `unsafe` to allow other paths.
  - **Edit the document in the preview**: *click* a block to highlight its
    source line in the split editor and any open text editor. *Double-click* a
    title, heading, paragraph, admonition, list item or code block to edit it
    in place. The box shows that block's AsciiDoc source, so markup like
    `*bold*` and links is kept. <kbd>Enter</kbd> applies a title or heading;
    other blocks take several lines, so use <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
    or click outside. <kbd>Escape</kbd> cancels, and clearing a block removes
    it. Tables and description lists are edited in the source.
  - Diagrams can be edited in the preview (select, rename, delete), also
    the ones in included chapters and `plantuml::` files, and elements that
    come from `!include`d files. Each change goes to the file the line came
    from. Renaming an identifier declared in an included file (e.g. `actor
    User` in `actors.iuml`) also renames its uses in the other files of that
    diagram.
  - **Clicking content from another file** switches the split editor to that
    file, at that line, so you can edit it there: a paragraph or heading of an
    `include::`d chapter, a diagram from a chapter or a `plantuml::` macro, or
    a diagram element defined in an `!include`d file (e.g. an actor from
    `actors.iuml`). The preview stays as it is, so you keep your place and
    see your edits in context; *(preview: manual.adoc)* in the toolbar tells
    you so, and clicking it previews the edited file on its own. Blocks of
    included chapters can also be edited in place by double-clicking, like the
    document's own. This works the same in PlantUML files. Clicking the
    document's own content switches the editor back.
  - Relative images and links work: web links open in the browser, links to
    other files open in VS Code.
- **AsciiDoc in the text editor**: `.adoc`, `.asciidoc` and `.asc` files get
  syntax highlighting (with PlantUML highlighting inside `[plantuml]` blocks),
  <kbd>Ctrl</kbd>+<kbd>/</kbd> line comments, bracket pairing, and folding of
  sections and delimited blocks, also in diffs and merge views. If the
  [AsciiDoc extension](https://marketplace.visualstudio.com/items?itemName=asciidoctor.asciidoctor-vscode)
  is installed too, both register the same language.
- **Diffs show the rendered versions side by side**, e.g. when you click a
  changed file in Source Control. The old side is read-only and shows its
  includes as they were in that version (from git).
  - **Changes are highlighted**: removed or changed content in red on the left,
    added or changed content in green on the right. This covers paragraphs,
    headings, list items, tables and diagram elements (participants, messages,
    classes, members…), also those from included files. A dashed frame marks
    a diagram with changes, also changes that have no element of their own
    (e.g. a `skinparam`). A thin line in the other side's color shows where
    content is that only the other side has.
  - **Both sides scroll together**, by content: scrolling one side brings
    the same heading, paragraph or diagram to the top of the other, even
    where one side has more content above it.
  - The arrows in the toolbar (or <kbd>F7</kbd> / <kbd>Shift</kbd>+<kbd>F7</kbd>)
    jump between changes. Changes that don't render (attributes, comments) are
    counted in the tooltip.
  - The changes are worked out from the source, so a diagram that only
    looks different because PlantUML laid it out differently isn't marked.
  - For the line-by-line text diff, use *Reopen Editor With… → Text Editor* on
    the diff tab, or make it the default with
    `"workbench.diffEditorAssociations": { "*.adoc": "default", "*.puml": "default" }`.
- **Export** the rendered diagram to `.svg` with `AsciiDoc & PlantUML: Export Diagram as SVG`.
- Double-click the preview to jump back to the source.
- Basic syntax highlighting for `.puml`, `.plantuml`, `.pu`, `.iuml`, and `.wsd`.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `asciidocPlantumlLive.theme` | `auto` | `auto`, `light`, or `dark` |
| `asciidocPlantumlLive.renderDelay` | `300` | Milliseconds to wait after the last edit before re-rendering |
| `asciidocPlantumlLive.resolveIncludes` | `true` | Inline local `!include` files |
| `asciidocPlantumlLive.asciidoc.safeMode` | `safe` | `unsafe` lets AsciiDoc `include::` read files outside the document's folder |

## Development

```sh
npm install
npm run build   # fetch-runtime (pinned engine) + compile
```

Press <kbd>F5</kbd> in VS Code to start an Extension Development Host with the
`examples/` folder open; this runs `build` first. Run `npm run package` to build
a `.vsix`. The `.vsix` is about 30 MB, mostly the standard library bundles.

## Notes and limitations

- js-plantuml is marked **beta** upstream, so a few diagram types or features
  may behave differently from the Java version.
- The first render after opening a preview takes a few seconds while the
  roughly 5 MB engine loads. After that, renders take milliseconds.
- URL includes (`!include https://...`) aren't fetched. The preview's Content
  Security Policy blocks network access.

## License

The extension's own code is [MIT](LICENSE). The bundled PlantUML engine
(`media/vendor/`), Viz.js, Monaco Editor and Asciidoctor.js keep their own
licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
