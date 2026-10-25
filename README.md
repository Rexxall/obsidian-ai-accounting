<div align="center">

# AI Accounting for Obsidian

**A multi-currency expense ledger in plain Markdown. Type it or photograph the receipt, check what the AI read, then save.**

用 Markdown 记的多币种账本：打字或拍小票，先核对 AI 读出来的内容，再入账。

[Features](#features) · [Install](#install) · [Privacy](#privacy) · [How it works](#how-it-works) · [中文说明](#中文说明) · [日本語](#日本語)

<img src="docs/screenshots/ledger.jpg" width="860">

</div>

## Why

Most expense apps keep your data in their own database, and the ones that read receipts for you save whatever they guessed. This plugin keeps every month as an ordinary Markdown table in your vault, and the AI never writes to it directly: it fills a review form, you correct the rows, and only then are they saved.

## Features

### Recording

- **Quick entry** on the dashboard: amount, description, category, currency, payment method.
- **From text or images.** Run *Process Current Note for Bookkeeping*, or drop a receipt photo or a note into an inbox folder. The AI returns draft rows; you edit date, shop, category, amount, currency and payment method, then confirm.
- **Inbox folders.** One shared inbox, plus an optional inbox per person, so a receipt lands in the right member's ledger.
- **Multi-currency.** Each row keeps its original amount and currency, the rate used, and the amount in your base currency.
- **Split a bill.** Tick *AA/分账* to divide a purchase evenly among the people you set up.

<img src="docs/screenshots/review.jpg" width="860">

### Reviewing

- **Transactions first.** The dashboard opens on the list for the selected member and period, with search and filters.
- **Charts:** categories (with drill-down into sub-categories), payment methods, monthly trend, and per-member comparison.
- **Edit, re-categorise, rename a category across a year, delete** (delete asks for a second click).
- **Export** the current view as CSV.
- **Daily notes.** Optionally append each day's spending to your daily note.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/charts-dark.jpg">
  <img src="docs/screenshots/charts.jpg" width="860">
</picture>

### AI services

- Google Gemini, or any OpenAI-compatible service (OpenAI, a local Ollama, other providers).
- **Several endpoints with fallback.** If the first service fails, the next enabled one is tried.

## Install

1. Download `obsidian-ai-accounting-0.3.0.zip` from the latest release.
2. Unzip it into `<your vault>/.obsidian/plugins/ai-accounting-plugin/` (it should contain `main.js`, `manifest.json`, `styles.css`).
3. **Settings → Community plugins**, reload, enable **AI Accounting Plugin**.
4. Click the pie-chart icon in the left ribbon, or run **Open Financial Dashboard**.

Works on desktop and mobile. The AI features need your own API key.

## Privacy

| What | Where it lives |
|---|---|
| Ledgers | Markdown files in your vault, one per month (`Finances/YYYY-MM.md` by default) |
| Settings and API keys | This plugin's `data.json` in your vault |
| Text or images you choose to process | Sent to the AI service you configured, only when you process a note or a file arrives in an inbox folder |
| Exchange rates | Requested from `frankfurter.app` and cached in the plugin folder |
| Gemini key | Sent in a request header, never in the URL |

No account, no server of our own, no analytics.

## How it works

- **One table row per transaction.** Each row ends with a hidden `<!-- aa:ID -->` marker. Edits and deletes find a row by that ID, not by matching date and amount, so two identical coffees on the same day stay two rows.
- **Safe cells.** Pipes, line breaks and `<` `>` in a description are escaped before writing and restored when reading, so a shop name cannot break the table.
- **No stale overwrites.** Before editing a row, the plugin checks that the row still reads the way it did when the dashboard loaded. If the file changed in between, it asks you to refresh instead of overwriting.
- **Idempotent imports.** Draft rows from the same source get the same IDs, so processing a receipt twice does not add it twice.
- **Validation.** Dates must be real calendar dates, amounts non-negative, currencies three-letter codes, and rates positive.
- **Archiving.** Processed inbox files are moved to an archive folder; if none is set, they go to Obsidian's trash according to your settings, never deleted outright.

Build from source:

```bash
npm install
npm run build   # type-check and bundle main.js
npm test        # ledger and request tests
npm run lint
```

## Known limits

- This is an expense ledger. Income, transfers and account balances are not modelled.
- Editing a transaction into a different month is blocked for now.
- Splitting a bill writes each member's share separately; it is not a single transaction across files.
- The dashboard still has untyped chart code; `npm run lint` reports it as warnings.
- The interface is in Chinese.

## Changelog

**0.3.0**

- Processed inbox files go to the trash instead of being deleted when no archive folder is set.
- CSV export now escapes quotes correctly.
- AI output is checked before use: a non-text value can no longer end up as `[object Object]` in your ledger.
- Delete asks for a second click instead of a browser dialog.
- The dashboard updates right after an import is confirmed, and charts redraw when you switch between light and dark themes.
- Default Gemini model updated to `gemini-2.5-flash`; the retired 1.5 default is migrated.
- Removed the ribbon button that only showed a notice, unused code and the `lodash` dependency.

**0.2.1** — Review before saving; record IDs; safe Markdown cells; the Gemini key moved from the URL to a header.

## License

MIT

---

## 中文说明

多数记账应用把数据放在自己的数据库里；会读小票的应用，往往直接把猜到的结果存进去。这个插件把每个月存成库里的普通 Markdown 表格，AI 也不会直接写账：它只填一张核对表，你改好每一行再确认入账。

- **录入：** 仪表盘快速录入；对当前笔记或放进收件文件夹的小票照片，AI 先给出草稿，你逐行改日期、商户、分类、金额、币种、支付方式后再确认；可为每位成员设专属收件文件夹。
- **多币种：** 每行保留原币金额、所用汇率和本币金额。
- **分账：** 勾选“AA/分账”，在设置的成员之间平均分摊。
- **查看：** 默认显示明细；分类（可下钻）、支付方式、月度趋势、成员对比图表；编辑、改分类、按年批量改名、删除（需点两次）；导出 CSV；可追加到日记。
- **AI 服务：** Gemini 或任意 OpenAI 兼容服务，多个服务按顺序自动切换。
- **数据安全：** 每笔交易带隐藏标识，按标识编辑；描述里的竖线和换行会安全转义；文件在你打开后被改过就提示刷新，不会覆盖；同一张小票重复处理不会重复入账。

## 日本語

毎月の家計簿を、保管庫の中の普通の Markdown 表として残す多通貨の支出帳です。AI は直接書き込まず、確認フォームに下書きを入れるだけです。日付・店名・分類・金額・通貨・支払方法を直してから記帳します。

- **入力：** ダッシュボードから手入力。ノートやレシート写真を受信フォルダに入れると、AI が下書きを作ります。メンバーごとの受信フォルダも設定できます。
- **多通貨：** 元の金額と通貨、使ったレート、基準通貨での金額を行ごとに保存します。
- **確認：** 明細、分類別（下位分類まで）、支払方法、月別推移、メンバー比較のグラフ。CSV 書き出し、日記への追記にも対応。
- **AI：** Gemini または OpenAI 互換サービス。複数のサービスを順に試します。
- **安全性：** 取引ごとに見えない ID を付けて編集し、表を壊す文字はエスケープします。同じレシートを二度処理しても二重に記帳されません。
