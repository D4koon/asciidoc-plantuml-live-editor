# 05: One message protocol

Status: done

Spec: `.scratch/deepen-preview-modules/spec.md` (Protocol module)

**What to build:** One definition of every message between the extension and its webviews, in both directions, for both the preview and the diff webview. The update message is fully typed and carries the Diagrams; it is no longer a loose key-value record. The webview scripts stay plain JavaScript with type checking and get the protocol's types through documentation-comment type imports. Only types cross over, so no bundler is needed. Each side handles messages by type against the shared definition.

**Blocked by:** 03 (Webview switches to Diagrams), so the update describes the final Diagram shape.

- [x] One protocol definition covers preview and diff messages in both directions
- [x] The diff view's separate message types are folded into it
- [x] The extension sends only messages that match the protocol (no untyped update record)
- [x] The webview scripts type-check against the protocol; their hand-kept copy of the update fields is deleted
- [x] Changing a message's shape causes a type error on both sides (checked once by hand)
- [ ] Preview and diff view behave as before (checked by hand)

## Notes from ticket 03

- Rename the diff view's `DiagramLine`, a name the glossary avoids (it is a line of a Diagram with its Origin). `ExpandedDiagram` is gone since ticket 04: select/rename/delete carry the Diagram.

## Notes

- The protocol is `src/protocol.ts` (`ToWebview`, `FromWebview`). The webview is type-checked against it by `npm run typecheck` (`tsconfig.webview.json`, with `media/webview.d.ts` declaring the webview's globals). Renaming a field of the update message was checked to break both sides.
- The webview check is not strict (no strictNullChecks), so a missing optional field isn't caught there yet; turning `strict` on is a possible follow-up.
- The diff view now takes Diagrams; `DiagramLine` is gone.
