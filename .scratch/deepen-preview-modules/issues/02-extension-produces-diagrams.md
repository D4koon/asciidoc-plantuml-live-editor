# 02: Extension produces Diagrams with Origins (expand)

Status: ready-for-agent

Spec: `.scratch/deepen-preview-modules/spec.md` (Diagram module, Testing Decisions)

**What to build:** The extension cuts every **Diagram** out of the document itself, for both PlantUML files and AsciiDoc documents, and sends them with every update. A Diagram has its lines with includes expanded, exactly as the engine saw them, an **Origin** for each line (a file in the Version plus a line, or none), and where it sits in the document. Origins are always sent, even when the mapping looks trivial. Lines the engine added (such as a wrapping `@startuml`/`@enduml`) carry their real text and have no Origin. A single Origin shape replaces the line map, the file-index origins and the URI and line tuple on the extension side.

This is the "expand" half: the old fields are still sent, so the webview keeps working unchanged until ticket 03.

**Blocked by:** 01 (Version module).

- [ ] Every update carries the Diagrams of the rendered document, for both PlantUML and AsciiDoc
- [ ] Every line of every Diagram has an Origin or explicitly has none; nothing is left out
- [ ] Lines the engine added have their real text and no Origin
- [ ] Diagram building reads through the Version, so its reads are recorded
- [ ] Tests through an in-memory Version cover: a plain PlantUML file; a PlantUML file with nested includes; an AsciiDoc document with listing blocks and `plantuml::` macros; added `@startuml`/`@enduml` lines; `!include_many` of the same file
- [ ] The webview still works on the old fields (checked by hand)
