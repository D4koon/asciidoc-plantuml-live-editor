# 04: One edit module

Status: ready-for-agent

Spec: `.scratch/deepen-preview-modules/spec.md` (Edit module, Testing Decisions)

**What to build:** One module turns an edit plan over a **Diagram** into line edits grouped by file, or a refusal with a reason. The plan comes from the existing pure rename/delete planners or the AsciiDoc block planner. Rename, delete and AsciiDoc block removal from the preview all go through it. A diagram without includes is the case where every Origin is the document itself, so the separate plain-diagram applier disappears.

Rules:
- All-or-nothing: if any line to edit has no Origin, refuse the whole edit with the "couldn't find, edit in the text editor" message.
- If any line's file changed since the render (its current text no longer matches the Diagram), refuse the whole edit with the "changed, please try again" message.
- Each source line is edited once, even when a file is included more than once (`!include_many`).
- Deleting a file's last line also removes the preceding line break, so no empty line is left. Deleting the only line leaves an empty file.
- AsciiDoc block removal also removes its separating blank line.

The VS Code step only turns the per-file edits into a workspace edit and applies it. It contains no rules.

**Blocked by:** 02 (Extension produces Diagrams). Can run in parallel with 03.

- [ ] Rename, delete and AsciiDoc block removal all go through the edit module
- [ ] The three hand-written appliers in the preview are gone; what's left only applies the per-file edits
- [ ] Tests cover: rename across several files; delete; block removal with its separating blank line; refusal when a line has no Origin; refusal when a file changed since the render; `!include_many` edited once; deleting a file's last line leaves no empty line; deleting the only line leaves an empty file
- [ ] Checked by hand: rename and delete in a diagram with includes and in one without; removing an AsciiDoc block
