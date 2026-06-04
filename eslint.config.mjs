import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ESLint flat configuration.
 *
 * `typescript-eslint` is still built against the TypeScript 6 API and refuses to
 * load when the TypeScript 7 compiler's programmatic API is installed, so
 * `typescript` is installed as an npm alias of `@typescript/typescript6`
 * (which supplies the API typescript-eslint consumes) while `@typescript/native`
 * supplies the TypeScript 7 `tsc` binary used by `build` / `type-check`.
 * See package.json. This mirrors the side-by-side layout documented for
 * TypeScript 7 (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
 *
 * Deliberately not type-aware: the non-type-checked `recommended` preset keeps
 * lint fast and independent of which of the three tsconfigs owns a given file,
 * while still catching the real problems in this codebase.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "drizzle/**", "coverage/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Intentionally unused bindings are marked with a leading underscore in this
      // codebase (e.g. Express handlers and accessors that only need some of their
      // parameters), so honour that convention rather than flagging those bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);