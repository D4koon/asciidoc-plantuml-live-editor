# Third-party notices

The AsciiDoc & PlantUML Live Editor package bundles the components below. They are not covered
by the extension's MIT license (see `LICENSE`); each keeps its own license.

## PlantUML (js-plantuml)

- Files: `media/vendor/` (`plantuml.js`, `themes.js`, `emoji.js`,
  `openiconic.js`, and the standard library bundles `*.min.js`)
- Source: <https://github.com/plantuml/plantuml>, release asset
  `js-plantuml-<version>.zip`; the exact version, download URL and SHA-256
  are recorded in `media/vendor/VERSION.json`
- License: PlantUML is published under several licenses: GPL-3.0 (the
  license file of its repository), LGPL-3.0, Apache-2.0, EPL-2.0 and MIT.
  See <https://github.com/plantuml/plantuml#-license>.
- The standard library (`!include <C4/...>`, `<awslib/...>`, …) is a
  collection of third-party libraries, each with its own license and icon
  terms. See <https://github.com/plantuml/plantuml-stdlib>.

## Viz.js

- File: `media/vendor/viz-global.js`
- Source: <https://github.com/mdaines/viz-js>
- License: MIT, Copyright (c) Michael Daines
- Viz.js contains, in object code form, Graphviz (<https://www.graphviz.org>,
  Eclipse Public License 1.0) and Expat (<https://libexpat.github.io>, MIT).

## Monaco Editor

- Files: `media/monaco/`
- Source: <https://github.com/microsoft/monaco-editor>
- License: MIT, Copyright (c) 2016 - present Microsoft Corporation
- Monaco's own third-party notices:
  <https://github.com/microsoft/monaco-editor/blob/main/ThirdPartyNotices.txt>

## Asciidoctor.js

- Files: `node_modules/@asciidoctor/core/`
- Source: <https://github.com/asciidoctor/asciidoctor.js>
- License: MIT, Copyright (C) 2013-present Dan Allen, Guillaume Grossetie,
  Anthony Vanelverdinghe, and the Asciidoctor Project
- Includes the Opal runtime (<https://github.com/opal/opal>, MIT).
