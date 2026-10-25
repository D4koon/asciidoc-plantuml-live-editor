# 01: Version module, plus Vitest

Status: done

Spec: `.scratch/deepen-preview-modules/spec.md` (Version module, Testing Decisions)

**What to build:** Every file read in the extension goes through one **Version** (see GLOSSARY.md). A disk Version uses the text of an open editor document if there is one, otherwise the file on disk. Whether the document has unsaved changes doesn't matter. A git Version reads the file at its ref. "Same file" means same Version and same path, compared case-insensitively on Windows. Every file read through a Version is recorded, and that record is the render's dependency list.

The Version module grows out of the existing module that already defines git versions, read-only status and finding an included file in the same Version. It serves both kinds of caller: synchronous reads (AsciiDoctor's include hook) and asynchronous reads (PlantUML includes, diffs). For a git Version, files are read in advance inside the module, so the caller no longer fills a lookup table.

There are two adapters: the VS Code workspace (production) and an in-memory set of files, each with its text and whether it's open (tests). The Version's rules must live apart from its VS Code adapter, because tests run where the `vscode` module doesn't exist.

Add Vitest so TypeScript tests run directly, with an npm `test` script.

**Blocked by:** None (can start immediately).

- [x] Vitest is installed, and `npm test` runs TypeScript tests without the VS Code runtime
- [x] An in-memory Version adapter exists for tests
- [x] All text reads (PlantUML includes, AsciiDoc includes, `plantuml::` macros, diffs, preview) go through the Version
- [x] `plantuml::` macros and `include::` directives use the same unsaved-changes rule (open document's text first)
- [x] One "same file" rule is used everywhere, case-insensitive on Windows; both duplicated file-key helpers are deleted
- [x] The separate open-document text reader and the pre-filled text lookup table are deleted
- [x] Re-rendering when a dependency changes uses the files the Version recorded, and fires when an include path's letter case differs from the file's on Windows
- [x] Tests cover: an open document wins over the file on disk; a git Version reads includes from the same ref; a letter-case difference on Windows counts as the same file; reads are recorded
- [ ] Preview, AsciiDoc preview and the diff view behave as before (checked by hand)

## Notes

- Includes with `lines=`/`tags=` are still read by Asciidoctor itself, as before this ticket: they use saved text, and in a git version the working tree's file. Fixing it means selecting lines/tags ourselves; not done here.
- An include of a closed file on disk is read by Asciidoctor itself (the same text the Version has), so options like `indent=` keep working as before. Every include:: target is still read through the Version first, so it is recorded.
- The unsaved-file reminder and dirty markers still compare URIs by their text; left for ticket 04.
