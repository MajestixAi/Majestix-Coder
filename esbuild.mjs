import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: !watch,
};

/** @type {import('esbuild').BuildOptions} — markdown renderer (kept for backward compat) */
const markdownConfig = {
  entryPoints: ["src/sidebar/webview/markdown.ts"],
  bundle: true,
  outfile: "dist/webview-markdown.js",
  format: "iife",
  globalName: "webviewMarkdown",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  minify: true,
};

/** @type {import('esbuild').BuildOptions} — Preact webview app */
const webviewConfig = {
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !watch ? false : true,
  minify: !watch,
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "text" },
};

if (watch) {
  Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(markdownConfig),
    esbuild.context(webviewConfig),
  ]).then(([extCtx, mdCtx, wvCtx]) => {
    extCtx.watch();
    mdCtx.watch();
    wvCtx.watch();
    console.log("Watching for changes...");
  });
} else {
  Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(markdownConfig),
    esbuild.build(webviewConfig),
  ]).then(() => {
    console.log("Build complete.");
  });
}
