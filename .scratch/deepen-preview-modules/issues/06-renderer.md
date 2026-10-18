# 06: Move the renderer out of Preview

Status: ready-for-agent

Spec: `.scratch/deepen-preview-modules/spec.md` (Renderer module, Testing Decisions)

**What to build:** A renderer module takes a render target (a document and its format), a **Version** and settings, and returns a typed update (rendered content and Diagrams, as the protocol defines) plus its dependencies, taken from what the Version recorded. It owns choosing AsciiDoc or PlantUML rendering, the error fallback, and producing Diagrams. It doesn't read editor configuration: Preview reads the settings and passes them in.

Preview keeps only timing (debounce and the guard against out-of-order renders), posting, panel lifecycle, navigation state, link handling and HTML generation. SVG export and the diff view reuse the renderer.

The rendering tests from ticket 02 move up to the renderer and are extended to check the full update. They replace the old tests rather than adding a second set.

**Blocked by:** 04 (One edit module) and 05 (One message protocol). It doesn't strictly need 04; the dependency avoids two tickets editing Preview at the same time.

- [ ] Rendering lives in its own module with no dependency on editor configuration or the webview
- [ ] Preview no longer renders or collects dependencies itself
- [ ] SVG export uses the renderer, so the export matches the preview
- [ ] Rendering tests run against the renderer and check the full typed update and its dependencies; the ticket-02 tests they replace are deleted
- [ ] Preview, AsciiDoc preview, diff view and SVG export behave as before (checked by hand)

## Notes from ticket 03

- AsciiDoc rendering still prepares diagrams in an older private shape (with a line map) and converts them to Diagrams at the end; have it produce Diagrams directly.

## Notes from ticket 05

- The update message has `html`, `blocks` and `titleBlock` as separate optional fields that only make sense together (an AsciiDoc document); the renderer's typed update could group them.

