# Examples

Test files for the extension. Press F5 in the project to open this folder in a
development window.

## PlantUML include chains

| File | What it exercises |
|------|-------------------|
| `sequence.puml` | Two diagrams in one file; the second includes `shared/styles.iuml` |
| `checkout.puml` | Three levels deep (`actors` → `styles` → `colors`), `!include_once` deduplication, `library.puml!auth` / `!billing` id selectors |
| `model/domain.puml` | Includes across folders: `order.iuml` → `customer.iuml` → `../shared/styles.iuml` → `colors.iuml` |
| `shared/library.puml` | Fragments with `@startuml(id=…)`; shows both when opened directly |
| `shared/*.iuml`, `model/*.iuml` | Fragments without `@startuml`; they also render when opened on their own |
| `edge-cases/cycle.puml` | `a.iuml` and `b.iuml` include each other; the cycle is broken with a comment |
| `edge-cases/missing-include.puml` | Shows PlantUML's "cannot include" error |

Editing `shared/colors.iuml` and saving updates every open preview that
includes it.

## AsciiDoc include chains

| File | What it exercises |
|------|-------------------|
| `document.adoc` | Diagram blocks, a titled diagram, `plantuml::` macro |
| `docs/manual.adoc` | `include::` chains: chapters → sections and snippets. Diagrams in included files (read-only), a `plantuml::` macro whose `.puml` has its own include chain, and an editable diagram in the manual itself |

```
docs/manual.adoc
├─ chapters/01-introduction.adoc
│  └─ chapters/snippets/tip.adoc
└─ chapters/02-architecture.adoc
   ├─ chapters/sections/components.adoc   ([plantuml] with !include ../../../shared/styles.iuml)
   └─ plantuml::../model/domain.puml[]
```
