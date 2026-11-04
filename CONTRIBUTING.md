# Contributing

```bash
npm ci
npm run build   # styles.css from styles/, type-check, then src/ -> main.js
npm run lint    # Obsidian's lint rules, the directory's typed scorecard checks, stylelint
npm test        # node --test on tests/*.test.cjs
```

The tests bundle each source file with esbuild and run it against a stand-in for the Obsidian module; they never reach the network. `styles.css` is generated: edit `styles/plugin.css`, run `npm run styles` and commit both. Versions are in [CHANGELOG.md](CHANGELOG.md).

Keep what the plugin sends and stores as the README's *Where your data goes* describes it: a change that sends data somewhere new, or stores a key outside Obsidian's secret storage, needs that table updated in both READMEs too.

CI runs lint, tests and a build on Node 20 and 22 for every push to `main` and every pull request, and fails if the build changes the committed `styles.css` or `manifest.json`. Pushing a version tag such as `0.7.2` runs the release workflow: it checks the tag against `manifest.json`, `package.json`, `package-lock.json` and `versions.json`, runs the same checks, attests `main.js`, `manifest.json` and `styles.css`, and creates the release with that version's CHANGELOG section as its notes.

## Issues

Report bugs and ideas in [GitHub Issues](https://github.com/Rexxall/obsidian-ai-accounting/issues). For a problem with an AI service, click **Test** next to it in settings, then the copy button beside it, and paste those diagnostics: they contain the service, address, model, step and error, but no key and no ledger content. Never paste an API key, and replace real receipts and amounts with made-up ones.
