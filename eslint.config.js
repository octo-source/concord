import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/", "app/fixtures/", "tests/fixtures/"],
  },
  js.configs.recommended,
  {
    files: ["server/**/*.js", "demo/**/*.js", "tools/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      // BOM (U+FEFF) appears deliberately inside regex literals that strip a
      // leading byte-order mark from ingested files (transcript.js, dictionary.js).
      "no-irregular-whitespace": ["error", { skipRegExps: true }],
    },
  },
  {
    files: ["app/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
];
