# 03: Webview switches to Diagrams (contract)

Status: ready-for-agent

Spec: `.scratch/deepen-preview-modules/spec.md` (Diagram module)

**What to build:** The webview stops splitting diagrams and rebuilding origins. It only looks things up in the Diagrams the extension sends (ticket 02). Clicking an element jumps to its Origin, in whichever file that is. The diff view matches lines by Origin. Edit requests refer to Diagram lines. Clicking a line with no Origin does nothing. PlantUML and AsciiDoc diagrams behave identically.

This is the "contract" half: delete the webview's own diagram splitting, its document-position-to-line lookup, the four functions that rebuilt lines and origins, and the old line-map and origin fields in the update message.

**Blocked by:** 02 (Extension produces Diagrams).

- [x] The webview no longer splits diagrams out of the document text
- [x] The functions that rebuilt lines and origins in the webview are deleted; every consumer reads the Diagram
- [x] The old line-map and origin fields are no longer sent
- [x] Lines the engine added are treated the same way everywhere (the two different fillers are gone)
- [ ] Checked by hand in the preview: jump-to-source in a plain diagram, in an included file, and in an AsciiDoc diagram; clicking an added line does nothing; the diff view highlights changes in included files on the right lines; rename and delete from the preview still work

## Notes from ticket 02

- The Diagrams arrive as `diagramList`; rename it to `diagrams` when the old AsciiDoc `diagrams` field is removed.
- `block` differed from what the webview computed: for text without markers it was the whole document (`start: 0`), where the webview used `start: -1`; for an unterminated diagram its end was the document's last line, where the webview used one past it.

## Notes

- Resolved the other way round: the Diagram's `block` now encloses the written lines (-1 and the document's length when the markers were added), because the edit planner treats block bounds as exclusive, as the webview did; AsciiDoc delimiters already fit.
- The webview's remaining helpers (`locateInDocument`, `originElsewhere`, `expandedDiagram`, `diagramLines`) only look things up in the element's Diagram.
- `ExpandedDiagram` (the edit messages) and `DiagramLine` (the diff view) keep names the glossary avoids; ticket 05 renames them with the protocol.
