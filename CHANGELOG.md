# Changelog

## 0.8.0

- **Import statements with suggested categories.** A command (and the file menu of a CSV in the vault) reads Alipay, WeChat Pay, Japanese bank and card, and plain Date / Description / Amount CSV files on this device, in UTF-8, GB18030 or Shift_JIS. Income rows, closed and failed payments are left out; refunds become negative rows and moves between your own accounts go to *Transfer*. A row is first filed as the same description was filed before in your ledger; only the remaining rows go to the enabled AI services, with just their description, amount, currency and the statement's own category. The review shows how many came from each, marks AI-suggested categories, flags rows that may already be entered, and writes nothing until confirmed.
- *Regenerate charts in all monthly reports* also finds ledgers named `账本 YYYY-MM`.
- **Ledger view for Bases.** A base can show its notes as a ledger: total, average and count, then one bar per note in the report currency, with a subtotal per group when the base is grouped. Monthly ledgers are read by their `total_expense`; for other notes, pick the amount property or the first one holding numbers is used. Registered only where Bases exists and is on; when Bases is turned on later, the view appears within a few seconds.
- **Monthly ledgers no longer share a name with monthly notes.** New ledgers are `账本 2026-01.md` (`Ledger 2026-01.md` with an English interface) and source archives `账本原文 2026-01.md`, so `[[2026-01]]` keeps pointing at the monthly note. Ledgers named `2026-01.md` are still read and written; the command *Rename monthly ledgers so they do not clash with monthly notes* renames them after showing the list and points links that name the folder at the new files; a bare `[[2026-01]]` is left to the monthly note.
- The saved exchange rates are read the first time a rate is needed instead of while Obsidian starts.

## 0.7.2

- **Receipts embedded in a note are read.** Running the command on a note (or dropping one in an inbox folder) used to send only the text, so `![[receipt.png]]` reached the AI as those words and the image never did. Now the images a note embeds (`![[…]]` or `![](…)`, up to six) go with the text to services that read images; with none, the message says to turn on *Reads images* or add such a service. The review shows the first image.
- Releases are built by GitHub Actions from the tag, with a build provenance attestation for `main.js`, `manifest.json` and `styles.css` (`gh attestation verify`). The release stops if the tag, `manifest.json`, `package.json`, the lockfile and `versions.json` disagree.
- CI runs lint, tests and the build on Node 20 and 22 for every push and pull request.

## 0.7.1

- **No exchange rate, no dead end.** When a rate cannot be fetched (offline, or a currency the rate service does not list), a dialog asks for it, filled in with the last rate seen for that currency. Entering recurring expenses, drafts, samples, quick entries and date changes all use it; cancelling writes nothing. The rate is saved with each entry and reused for that day.
- Settings say only what is sent where: inbox folders send files to the AI service at once, and to the next service if one fails.

## 0.7.0

- **Passes the community directory's review with no findings.** The TypeScript library is set to ES2021 instead of borrowing it from Node's typings, which the scanner does not install; it read 310 calls such as `Object.entries` as untyped.
- Styles use no `!important`, `all` or `:has()`: buttons and the search field reset Obsidian's look property by property, reduced motion zeroes the kit's timing variables and also stops the *Where it went* chevron, and the last row of a settings group is marked by the plugin. Nothing else looks different.
- `npm run lint` runs the directory's rules twice, once with full types and once without the dev typings, plus stylelint for those three CSS rules; any warning fails it. The old lint config that downgraded the unsafe-type rules to warnings is gone.

## 0.6.0

- **AI services in one list.** Gemini and the OpenAI-compatible endpoints are now one list. Each service has its own address, model and key, with presets for DeepSeek (default), Qwen, SiliconFlow, Kimi, Zhipu GLM, Gemini, OpenAI and any OpenAI-compatible or local server. Settings from 0.5.x move over by themselves.
- **Model list and test connection.** Fetch the models your key can use (free). The test checks the model list, then sends one tiny request, and says which of these it is: no key, key rejected, out of balance or quota, model not found, rate limited, no reply in time, or the service could not be reached. A copy button gives diagnostics without the key or any ledger content.
- **Reads images** per service: image receipts skip services that cannot read pictures.
- **Drafts are kept.** What the AI reads is saved as a draft before the review opens. Closing the dialog keeps it under *To review* on the ledger; the same receipt reuses its draft instead of being sent again; *Discard draft* throws it away and keeps the file.
- **Refunds, transfers, duplicates.** Mark a row as expense, refund (negative amount) or transfer (top-level category 转账 or Transfer, listed but not counted as spending). Rows matching an existing entry by date, currency and amount are marked *Maybe already entered*. Leave any row out before entering.
- **Progress, Cancel and Retry** while a receipt is read; *Open settings* when no service is set up.
- **Samples.** An empty ledger offers three sample rows, marked as samples and removable in one click. While the ledger is still loading, no empty state is shown.
- **English and Chinese interface**, following Obsidian's language. Currency and time zone never depend on it.
- **Narrow panes and phones:** the table keeps description and amount; tap a row to edit it.
- Charts leave out transfers and zero amounts.
- README in English and Chinese, with what is sent where and what it costs.
- Requires Obsidian 1.13.0.
- Settings rows, group titles, list chevrons and separators share one left and one right edge, on each service page too. Day headings line up with the checkboxes; the sample banner and *Where it went* rows line up with the cards; *By period* opens with a chevron on the right.
- Toggles are sized through Obsidian's own toggle variables, so the knob sits 2px from every edge when off and on. Pressed, it stretches inside the track (off to the right, on to the left) instead of growing past it; with reduced motion it neither stretches nor slides.

## 0.5.0

- New look in the style of current Apple apps: solid cards and grouped lists, a glass header bar and glass dialogs, settings drawn as grouped lists, charts in eight distinct colours (the seventh category no longer repeats the first colour). Follows your theme and accent colour; glass turns solid when the system asks for reduced transparency. The paper style option is gone.
- New id `ai-accounting` and name **AI Accounting**, as the community directory requires. Settings from `ai-accounting-plugin` are imported on first start.
- Monthly budgets by category, with a budget card on the ledger page.
- Recurring expenses, added each month through the review dialog and never twice.
- API keys move to Obsidian's secret storage and can be shared with other plugins. When an old file has both an endpoint list and the single OpenAI key from early versions, that key is kept as a disabled endpoint instead of staying in plain text.
- Requires Obsidian 1.13: settings use Obsidian's own lists and pages for members, recurring expenses and AI endpoints, and show up in settings search.
- Settings rebuilt with Obsidian's own section headings, toggles and buttons; no inline styles.
- Fixed: adding an entry from a day's detail in the charts view failed because the exchange rate was saved under the wrong field.
- Model replies are typed and checked; `npm run lint` passes with no errors.
- A quieter ledger header: Ledger and Charts, one month capsule that opens a month picker, a search field, and a single Filter button for day, month or year, currency, member, category and payment method.
- Row actions appear when you point at a row (always shown on touch screens); the member initial shows only in a ledger with more than one member.
- The review dialog lists one line per transaction with the full text; click a line to edit it, and pick the date from a month calendar. Lines with something missing open by themselves.

## 0.4.0

- The ledger reads like a ledger: grouped by day with a total for each day, totals and "where it went" beside it, and the period analysis folded away.
- Two identical purchases on the same day are marked as kept apart on purpose.
- The review window shows the receipt or note next to the draft, marks empty or unreadable cells, and adds up the total.
- Charts take their colours from the theme; the trend highlights the month you are viewing.
- Optional **纸墨风格 (Paper & ink style)** in settings. Off by default, so the dashboard follows your theme.
- Styles rewritten from scratch on a small shared style kit; the dashboard and dialogs no longer use inline styles.

## 0.3.0

- Processed inbox files go to the trash instead of being deleted when no archive folder is set.
- CSV export now escapes quotes correctly.
- AI output is checked before use: a non-text value can no longer end up as `[object Object]` in your ledger.
- Delete asks for a second click instead of a browser dialog.
- The dashboard updates right after an import is confirmed, and charts redraw when you switch between light and dark themes.
- Default Gemini model updated to `gemini-2.5-flash`; the retired 1.5 default is migrated.
- Removed the ribbon button that only showed a notice, unused code and the `lodash` dependency.

## 0.2.1

- Review before saving; record IDs; safe Markdown cells; the Gemini key moved from the URL to a header.
