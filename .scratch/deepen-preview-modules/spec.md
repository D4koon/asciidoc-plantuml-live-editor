# Spec: Deepen the preview's modules around Version, Diagram and edits

Status: done

## Problem Statement

The preview works, but the code behind it has no tests and can't easily get any. The same few questions are answered in several places, and the answers already disagree:

- **"What is the text of this file?"** It is answered five different ways. As a result, `plantuml::` macros and `include::` directives can disagree about whether to use unsaved changes. On Windows, a difference in letter case in a path can stop the preview from re-rendering when an included file changes.
- **"Which file and line did this diagram line come from?"** It is represented in four shapes. The webview rebuilds it in four functions, and two of them fill in the lines the engine added (`@startuml`/`@enduml`) differently.
- **Edits made from the preview** are applied by three hand-written copies of the same rules, and these already behave differently. Deleting the last line of an included file leaves an empty line, but deleting the last line of a standalone diagram doesn't.
- **The messages between the extension and the webview** are typed in only one direction. The webview copies the fields of an update by hand.
- **The `Preview` module** combines rendering, settings lookup, dependency tracking, editing, link handling and HTML generation. None of it can be tested without a running webview.

For the user, these problems show up as inconsistent edits and missed re-renders. For the maintainer, every change risks reintroducing a bug that was already fixed in one of the copies.

## Solution

Restructure the extension into a few deep modules, named after the domain terms in the glossary (**Version**, **Origin**, **Diagram**). Each one answers its question once, and its interface is the test surface. The work ships in five steps. Each step keeps the extension working and adds tests:

1. **Version**: one module answers "what is the text of this file in this Version" and "are these the same file", and records every file read through it.
2. **Diagram**: the extension produces every Diagram itself, for both PlantUML and AsciiDoc documents, with an Origin for every line. The webview only looks things up.
3. **Edits**: one module turns an edit plan over a Diagram into line edits for each file. Renames, deletes and AsciiDoc block removal all go through it.
4. **Protocol**: one definition of every message, in both directions, for both the preview and the diff webview.
5. **Renderer**: rendering moves out of `Preview` into a module that takes a render target, a Version and settings, and returns a typed update. `Preview` keeps only the timing and the posting.

The user sees the same features, with consistent edit behaviour and reliable re-rendering.

## User Stories

1. As a user editing a PlantUML file, I want the preview to use my unsaved changes in included files, so that I see what I'm about to save.
2. As a user editing an AsciiDoc document, I want `plantuml::` macros and `include::` directives to treat unsaved changes the same way, so that the preview never mixes saved and unsaved text.
3. As a user on Windows, I want the preview to re-render when an included file changes, even if the include path's letter case differs from the file's actual case, so that the preview never goes stale.
4. As a user comparing a file against a git version, I want the old side's includes to come from the same git ref, so that the old side renders as it actually was.
5. As a user comparing versions, I want the old side to be read-only in the preview, so that I can't accidentally edit history.
6. As a user, I want a diagram that includes other files to render from exactly the text that was read for that render, so that the preview and later edits agree.
7. As a user clicking an element in a diagram, I want the editor to jump to the line that element came from, even if it's in an included file, so that I can edit it at its source.
8. As a user clicking an element in a diagram without includes, I want the same jump-to-source behaviour, so that included and plain diagrams feel identical.
9. As a user clicking on a line the engine added (such as a wrapping `@startuml`), I want nothing to happen, so that I'm not sent to a line that doesn't exist.
10. As a user renaming a participant from the preview, I want every use of it renamed across all included files, so that the diagram stays consistent.
11. As a user renaming something declared in an included file, I want the declaration to be changed in that file, so that the rename really takes effect.
12. As a user deleting an element from the preview, I want its line removed from whichever file it came from, so that the deletion happens at the source.
13. As a user deleting the last line of a file from the preview, I want no empty line left behind, so that the file looks the same as if I'd deleted the line in the editor.
14. As a user deleting the only line of a file from the preview, I want the file left empty without an error, so that the edge case behaves predictably.
15. As a user whose diagram includes the same file twice, I want each source line edited once, so that a rename isn't applied twice.
16. As a user who changed a file after the preview rendered, I want an edit from the preview to be refused with a "please try again" message, so that the preview never overwrites text it didn't see.
17. As a user, I want an edit that touches several files to be applied fully or not at all, so that a rename never leaves the diagram half-renamed.
18. As a user, I want an edit that would touch a line the engine added to be refused with a clear message, so that I know to edit in the text editor instead.
19. As a user removing an AsciiDoc block from the preview, I want the block and its separating blank line removed in one step, so that the document keeps tidy spacing.
20. As a user removing an AsciiDoc block, I want the same refusal rules as diagram edits when the document has changed, so that every edit made from the preview behaves the same way.
21. As a user, I want PlantUML and AsciiDoc diagrams to behave identically in the preview (clicking, renaming, deleting, diffing), so that I don't have to learn two sets of rules.
22. As a user viewing a diff of diagrams, I want lines matched by their Origin, so that changes in included files show up in the right place.
23. As a user, I want an AsciiDoc document to re-render when any file it read changes, so that macros and includes stay current.
24. As a user, I want the preview to keep working while the restructuring happens, so that the work can ship one step at a time.
25. As a user, I want the preview to keep my settings (theme, engine options), so that the restructuring changes nothing I can see.
26. As a user exporting SVG, I want the export to use the same render as the preview, so that what I export is what I see.
27. As a maintainer, I want one module that answers "the text of a file in a Version", so that unsaved-change and git-version rules live in one place.
28. As a maintainer, I want one rule for "same file", so that case-sensitivity bugs can't come back in one caller only.
29. As a maintainer, I want every file read through a Version to be recorded, so that a render's dependencies are complete without extra code.
30. As a maintainer, I want an in-memory Version for tests, so that rendering and edit logic can be tested without VS Code.
31. As a maintainer, I want Diagrams produced only by the extension, so that rules about where diagrams start and end aren't duplicated in the webview.
32. As a maintainer, I want every Diagram to always carry its Origins, so that no consumer has to rebuild them.
33. As a maintainer, I want one edit module, so that end-of-line, end-of-file and refusal rules are fixed once and stay fixed everywhere.
34. As a maintainer, I want the last step that applies edits to the editor to be thin and free of logic, so that everything that can go wrong is in tested code.
35. As a maintainer, I want one message protocol shared by the extension and the webview scripts, so that a message change shows up as a type error on both sides.
36. As a maintainer, I want the diff webview's messages in the same protocol, so that there's no third definition.
37. As a maintainer, I want the webview scripts to stay plain JavaScript with type checking, so that no bundler is needed.
38. As a maintainer, I want rendering to take settings as an input, so that it doesn't read editor configuration and can be tested directly.
39. As a maintainer, I want `Preview` reduced to timing, posting, panel lifecycle and navigation, so that its remaining reasons to change are about the panel.
40. As a maintainer, I want every known bug (the last-line delete, the case difference in paths on Windows, inconsistent text for added lines) to have its own test, so that it can't come back.
41. As an agent picking up a ticket, I want each step to be independently shippable and to name what it depends on, so that I can implement one step at a time.
42. As a future reader, I want the glossary to define Version, Origin and Diagram, so that names in the code match names in discussions.

## Implementation Decisions

**Order and delivery.** The steps are Version → Diagram → Edits → Protocol → Renderer. Each step ships on its own and leaves the extension fully working.

**Version module.**
- **Location.** It grows out of the existing module that already defines what a version is: git versions, read-only status, and finding an included file in the same Version. It is not a new file alongside it.
- **Interface: "text of" this file.**
  - Disk Version: the text of an open editor document if there is one, otherwise the file on disk. Whether the document has unsaved changes doesn't matter.
  - Git Version: the file at that ref.
- **Interface: "same file".** Two files are the same if they're in the same Version and have the same path, compared case-insensitively on Windows.
- **Sync and async reads.** The interface serves both kinds of caller. AsciiDoctor's include hook needs synchronous reads, while PlantUML include resolution and diffs read asynchronously. For a git Version, the files are read in advance before a synchronous render, but this happens inside the module rather than through a lookup table the caller fills.
- **Recording reads.** Every file read through a Version is recorded, and that record is a render's dependency list.
- **Adapters.** There are two: the VS Code workspace (production) and an in-memory set of files, each with its text and whether it's open (tests).
- **What it replaces.** The existing ad-hoc text readers, the open-document lookup, the dirty-document lookup, the pre-filled text lookup table, and both duplicated file-key helpers are deleted.

**Diagram module.**
- **Where Diagrams come from.** The extension cuts every Diagram out of the document, both PlantUML and AsciiDoc. The webview no longer splits diagrams or maps a document position to a line.
- **What a Diagram carries.**
  - its lines, with includes expanded, exactly as the engine saw them
  - an Origin for each line (a file in the Version plus a line), or no Origin
  - where it sits in the document
- **Origins are always sent.** Nothing is left out when the mapping looks trivial.
- **Lines the engine added** (such as a wrapping `@startuml`/`@enduml`) carry their real text and have no Origin.
- **One shape for Origin** is used everywhere. It replaces the line map, the file-index origins, the URI and line tuple, and the per-line `at` field.
- **Webview changes.** The webview functions that reshaped diagrams are deleted. Consumers (clicking elements, the diff view, editing) all read the same Diagram.

**Edit module.**
- **Input and output.** The input is a Diagram and an edit plan over its lines (from the existing pure rename/delete planners and the AsciiDoc block planner). The output is line edits grouped by file, or a refusal with a reason.
- **Applies to every edit.** A diagram without includes is the case where every Origin is the document itself, so the separate plain-diagram applier disappears. AsciiDoc block removal is a plan over the document's own lines and goes through the same module.
- **Refusals are all-or-nothing.**
  - If any line to edit has no Origin, the whole edit is refused.
  - If any line's file has changed since the render (the current text no longer matches what the Diagram recorded), the whole edit is refused with a "changed, try again" message.
- **Each source line is edited once**, even if a file is included more than once.
- **Deleting a file's last line** also removes the preceding line break, so no empty line is left. This matches the editor's own behaviour and fixes the current mismatch.
- **Deleting the only line** of a file leaves the file empty.
- **The VS Code step** only turns the per-file edits into a workspace edit and applies it.

**Protocol module.**
- **Scope.** One definition covers every message in both directions (extension → webview and webview → extension), for both the preview webview and the diff webview.
- **Update payload.** The update message is fully typed and carries the Diagrams. It is no longer a loose key-value record.
- **The webview side** stays plain JavaScript with type checking and gets the protocol's types through documentation-comment type imports. Only types cross over, so no bundler is needed.
- **Message handling.** Each side handles messages by type against the shared definition. The webview's hand-kept copy of the update fields is deleted.

**Renderer module.**
- **Input and output.** The input is a render target (document plus format), a Version and settings. The output is a typed update (rendered content and Diagrams) plus its dependencies, taken from what the Version recorded.
- **Settings.** The renderer doesn't read editor configuration. `Preview` reads the settings and passes them in.
- **What it owns:** choosing AsciiDoc or PlantUML rendering, the error fallback, and producing Diagrams.
- **What `Preview` keeps:** timing (debounce and the guard against out-of-order renders), posting updates, panel lifecycle, navigation state, link handling and HTML generation. The HTML template isn't moved, because moving it would only relocate code without gaining anything.
- **Reuse.** SVG export and the diff view reuse the renderer's dependency knowledge.

**Glossary.** The code adopts the **Version**, **Origin** and **Diagram** terms, and the names they replace are retired.

## Testing Decisions

**What makes a good test here.** Tests go through a module's interface and check observable results, not internal state. They don't mock VS Code, the webview or the file system. A test should survive internal refactoring. If a test has to change when the implementation does, it is testing past the interface.

**Runner.** Vitest is added to the repo, running TypeScript directly. No VS Code integration tests are added in this work.

**Test seams.** The only point where code is swapped for a test double is the Version module, using the in-memory adapter. Everything above it runs as real code.

**Rendering interface** (Diagram module in step 2, Renderer in step 5):
- Input: a document in an in-memory Version, plus settings.
- Checks:
  - each Diagram's lines and Origins
  - which files were read
  - lines the engine added have no Origin
  - unsaved text is used when a file is open
  - a git Version reads includes from the same ref
  - a difference in letter case in paths on Windows still counts as the same file, and still triggers a re-render
- In step 5 the step-2 tests move up to the Renderer and are extended to check the full typed update. They replace the step-2 tests rather than adding a second set.
- The Version's own rules are tested through this interface. Step 1 adds a few direct Version tests only because no rendering module exists yet. Those tests are kept only where the rendering tests don't already cover the rule.

**Edit interface** (step 3):
- Input: a Diagram and an edit plan.
- Checks:
  - rename across several files
  - delete
  - AsciiDoc block removal with its separating blank line
  - refusal when a line has no Origin
  - refusal when a file changed after the render
  - files included more than once (`!include_many`) edited once
  - deleting the last line of a file leaves no empty line
  - deleting the only line leaves an empty file

**Protocol.** It isn't tested, because it only defines types and the compiler checks it.

**Untested on purpose:** `Preview`'s timing and posting, the VS Code adapters (including the step that applies edits), and the webview scripts. All of these are kept thin.

**Every known bug gets its own test:**
- deleting the last line of an included file
- a difference in letter case in paths on Windows
- the two different fillers for lines the engine added
- the two different rules for unsaved changes

**Prior art.** None, because the repo has no tests today. The existing pure edit planners are the closest thing to tested-style code, and they are tested through the edit interface rather than directly.

## Out of Scope

- Splitting split-editor synchronisation (echo suppression and versioning between the extension and the webview editor) into its own module. Deferred until it causes a bug.
- Converting the webview scripts to TypeScript, or adding a bundler.
- VS Code integration tests (launching an editor in tests).
- Moving the HTML/CSP template out of `Preview`.
- Any change to what users can do with the extension, apart from fixing the inconsistencies listed above.
- Moving issue tracking to GitHub.

## Further Notes

- There are no ADRs. None of these decisions is hard to reverse, surprising, or the result of a real trade-off.
- The glossary (Version, Origin, Diagram) was created during the design discussion, and should be updated if a step sharpens any term.
- After the steps shipped, two decisions here were reversed. The webview scripts are now tested: `test/webview/` drives the real preview page in Chromium (Playwright), against the real renderer and edit planning. For that, the HTML template moved out of `Preview` into its own module without VS Code, so the tests load the same page and Content-Security-Policy.
- A standards review of the same code found the duplication this spec removes. The remaining standards findings (unclear navigation-state names, small pass-through methods) can be fixed opportunistically as steps touch that code.
