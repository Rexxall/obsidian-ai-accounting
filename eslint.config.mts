import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Known typing debt in the dashboard (untyped chart data and parsed rows).
		// Kept visible as warnings rather than hidden; see README "Known limits".
		files: ["**/*.ts"],
		plugins: { "@typescript-eslint": tseslint.plugin, obsidianmd },
		rules: {
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",
			"obsidianmd/no-static-styles-assignment": "warn",
			"obsidianmd/settings-tab/no-manual-html-headings": "warn",
			// The interface is written in Chinese; sentence case does not apply.
			"obsidianmd/ui/sentence-case": "off",
			"no-console": ["error", { allow: ["warn", "error"] }],
		},
	},
	{
		files: ["tests/**/*.cjs"],
		languageOptions: { globals: { ...globals.node } },
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
