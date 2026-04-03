/**
 * Build script for the Zulip OpenClaw plugin.
 *
 * Compiles TypeScript to ESM JS, marking openclaw/* as external
 * so they resolve at runtime from the host's node_modules.
 */

import { build } from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outdir: "dist",
  // Mark all openclaw SDK imports as external — resolved at runtime
  external: ["openclaw", "openclaw/*"],
  sourcemap: false,
};

// Main entry
await build({
  ...shared,
  entryPoints: ["index.ts"],
  outdir: "dist",
});

// Setup entry
await build({
  ...shared,
  entryPoints: ["setup-entry.ts"],
  outdir: "dist",
});

console.log("Build complete → dist/");
