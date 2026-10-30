import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

// The community directory's review rules, with type information. Warnings fail the lint too (--max-warnings 0).
export function config(tsconfig) {
	return tseslint.config(
		{
			languageOptions: {
				globals: { ...globals.browser },
				parserOptions: tsconfig
					? { project: tsconfig, tsconfigRootDir: import.meta.dirname }
					: { projectService: { allowDefaultProject: ['manifest.json'] }, tsconfigRootDir: import.meta.dirname },
			},
			linterOptions: { reportUnusedDisableDirectives: 'error' },
		},
		...obsidianmd.configs.recommended,
		{
			files: ['src/**/*.ts'],
			rules: {
				'@typescript-eslint/no-redundant-type-constituents': 'error',
				'@typescript-eslint/no-unnecessary-type-assertion': 'error',
				// The interface is written in Chinese and English; sentence case does not apply to the Chinese strings.
				'obsidianmd/ui/sentence-case': 'off',
			},
		},
		// Same exclusions as the directory scanner.
		globalIgnores(['node_modules', 'main.js', 'release', 'docs', 'tests', '**/*.mjs', '**/*.cjs', 'versions.json', 'tsconfig*.json']),
	);
}

export default config();
