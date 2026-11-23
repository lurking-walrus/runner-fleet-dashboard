// `import html from "./timing.html"` is a text module (wrangler's default rule; esbuild's text
// loader in scripts/build-lambda.mjs). Do the same here so tests can import the whole Worker.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "html-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".html")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
