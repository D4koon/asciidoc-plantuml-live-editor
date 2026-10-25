# 06: Move the renderer out of Preview

Status: done

Spec: `.scratch/deepen-preview-modules/spec.md` (Renderer module, Testing Decisions)

**What to build:** A renderer module takes a render target (a document and its format), a **Version** and settings, and returns a typed update (rendered content and Diagrams, as the protocol defines) plus its dependencies, taken from what the Version recorded. It owns choosing AsciiDoc or PlantUML rendering, the error fallback, and producing Diagrams. It doesn't read editor configuration: Preview reads the settings and passes them in.

Preview keeps only timing (debounce and the guard against out-of-order renders), posting, panel lifecycle, navigation state, link handling and HTML generation. SVG export and the diff view reuse the renderer.

The rendering tests from ticket 02 move up to the renderer and are extended to check the full update. They replace the old tests rather than adding a second set.

**Blocked by:** 04 (One edit module) and 05 (One message protocol). It doesn't strictly need 04; the dependency avoids two tickets editing Preview at the same time.

- [x] Rendering lives in its own module with no dependency on editor configuration or the webview
- [x] Preview no longer renders or collects dependencies itself
- [x] SVG export uses the renderer, so the export matches the preview
- [x] Rendering tests run against the renderer and check the full typed update and its dependencies; the ticket-02 tests they replace are deleted
- [ ] Preview, AsciiDoc preview, diff view and SVG export behave as before (checked by hand)

## Notes from ticket 03

- AsciiDoc rendering still prepares diagrams in an older private shape (with a line map) and converts them to Diagrams at the end; have it produce Diagrams directly.

## Notes from ticket 05

- The update message has `html`, `blocks` and `titleBlock` as separate optional fields that only make sense together (an AsciiDoc document); the renderer's typed update could group them.


## Notes from implementing

- The renderer takes the document to render and the root whose includes the overview lists; it picks AsciiDoc or PlantUML by the document's name. `rendersAlone` (does a fragment render on its own?) moved there too, since it's a rendering question.
- A render's `dependsOn(uri)` applies the Version's same-file rule to everything the render read; Preview only adds the tab's file and the shown file (which may not have been read).
- The overview lists the root's includes separately only when the root isn't the rendered file by the same-file rule (before: by exact URI), so a letter-case difference on Windows no longer lists them twice.
- The error fallback (AsciiDoc conversion failed) isn't tested: no input makes Asciidoctor.js throw reliably. It now escapes the error text.
- SVG export needed no code change: it takes the SVGs the preview's webview drew from the renderer's update, so it already matches the preview.
- The update groups the AsciiDoc-only fields as `asciidoc: { html, blocks, titleBlock }`.
- AsciiDoc rendering produces Diagrams directly; include resolution returns an Origin per line, retiring the line map and the file-index origins.
- Version tests now covered by rendering tests (unsaved text, git ref, letter case on Windows) were deleted, as the spec asks.
