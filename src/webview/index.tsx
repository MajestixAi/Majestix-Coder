/**
 * Webview entry point — mounts the Preact app into #root.
 * This file is bundled by esbuild into dist/webview.js (IIFE).
 */

import { render } from "preact";
import { App } from "./App";
// esbuild imports .css as a text string (loader: { ".css": "text" })
import cssText from "./styles/index.css";

// Inject the CSS into the document
const styleEl = document.createElement("style");
styleEl.textContent = cssText;
document.head.appendChild(styleEl);

// Read the logo URI and other data attributes from the root element
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element not found");
const logoUri = rootEl.dataset.logoUri ?? "";

// Store the VS Code API globally so utility functions can use it
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
(globalThis as unknown as Record<string, unknown>).vscodeApi = acquireVsCodeApi();

render(<App logoUri={logoUri} />, rootEl);
