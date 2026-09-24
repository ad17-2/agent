import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp.ts"],
  format: ["esm"],
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  // Unminified: this is a small library, not a bundle-size-critical app,
  // and minified output was unreadable in raw (non-sourcemap-resolved) stack traces.
  minify: false,
});
