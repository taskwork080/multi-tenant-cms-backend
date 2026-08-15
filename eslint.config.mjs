import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The repo has always had a `lint` script; it had no config and eslint was not
 * installed, so `npm run lint` failed. This is the minimum that makes it run
 * and catch something real (unused symbols, floating promises are left off
 * because they need type-aware linting and a slower pass).
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "drizzle/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase leans on `any` at the JWT/payload boundary deliberately.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Drizzle's `sql` template and Nest decorators trip this constantly.
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
