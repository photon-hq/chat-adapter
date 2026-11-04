import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      // Chat SDK calls these as async methods on the adapter instance.
      files: ["src/adapter.ts"],
      rules: { "class-methods-use-this": "off", "require-await": "off" },
    },
  ],
  rules: {
    // Helpers are function declarations, below the code that calls them.
    "func-style": "off",
    "no-use-before-define": ["error", { functions: false }],
    // Keys are ordered by meaning, a union's `type` first, not alphabetically.
    "sort-keys": "off",
  },
});
