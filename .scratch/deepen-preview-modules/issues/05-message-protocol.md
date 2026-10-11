# 05: One message protocol

Status: ready-for-agent

Spec: `.scratch/deepen-preview-modules/spec.md` (Protocol module)

**What to build:** One definition of every message between the extension and its webviews, in both directions, for both the preview and the diff webview. The update message is fully typed and carries the Diagrams; it is no longer a loose key-value record. The webview scripts stay plain JavaScript with type checking and get the protocol's types through documentation-comment type imports. Only types cross over, so no bundler is needed. Each side handles messages by type against the shared definition.

**Blocked by:** 03 (Webview switches to Diagrams), so the update describes the final Diagram shape.

- [ ] One protocol definition covers preview and diff messages in both directions
- [ ] The diff view's separate message types are folded into it
- [ ] The extension sends only messages that match the protocol (no untyped update record)
- [ ] The webview scripts type-check against the protocol; their hand-kept copy of the update fields is deleted
- [ ] Changing a message's shape causes a type error on both sides (checked once by hand)
- [ ] Preview and diff view behave as before (checked by hand)

## Notes from ticket 03

- Rename the message types the glossary avoids: `ExpandedDiagram` (sent with select/rename/delete) and the diff view's `DiagramLine`; both are a Diagram's lines with their Origins.
