# Changelog

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
