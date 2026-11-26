import { defineConfig } from "vite-plus";

// The worker that runs the plugins' policies, with vscode-jsonrpc inside it: a mirror ships one
// file and Hermes installs nothing from npm.
export default defineConfig({
  pack: {
    entry: { bridge: "bridge.ts" },
    format: "cjs",
    platform: "node",
    outDir: ".",
    clean: false,
    dts: false,
    fixedExtension: true,
    noExternal: [/.*/],
  },
});
