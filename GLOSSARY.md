# AsciiDoc & PlantUML Live Editor

A VS Code extension that previews PlantUML diagrams and AsciiDoc documents live, and lets diagrams be edited from the preview, including across included files.

## Language

**Version**:
One consistent set of file contents that a document is rendered from: the files as open or saved in the workspace, or the files at a git ref (the old side of a diff). A document and everything it includes always come from the same Version.
_Avoid_: snapshot, revision, side

**Origin**:
The file and line, within a Version, that one line of a Diagram came from. A line the engine was given without being written anywhere (such as an added `@startuml`) has no Origin.
_Avoid_: line map, line origin, source position, at

**Diagram**:
One PlantUML diagram as the engine saw it, taken out of a document: its lines with includes expanded, and each line's Origin.
_Avoid_: expanded diagram, embedded diagram, diagram lines
