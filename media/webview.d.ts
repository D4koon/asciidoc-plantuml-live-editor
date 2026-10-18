// Globals of the preview's webview, for type-checking its scripts.

/** VS Code's API inside a webview; messages are the protocol's (src/protocol.ts). */
declare function acquireVsCodeApi(): {
  postMessage(message: import('../src/protocol').FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
};

/** Sends a message to the extension; the webview modules get it from preview.js. */
type PostToExtension = (message: import('../src/protocol').FromWebview) => void;

interface Window {
  /** Read by the PlantUML engine. */
  PLANTUML_DEBUG: boolean;
  /** Where the engine loads its standard library from. */
  PLANTUML_STDLIB_BASE: string | undefined;
}
