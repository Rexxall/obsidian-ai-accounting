Copy the prompt for your problem into your AI coding assistant, replacing `<vault>` with your vault folder.

## The AI service test fails

```text
AI Accounting's Test connection fails. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-accounting/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Ask me for the diagnostics from the copy button beside Test, without requesting a key value. Check the enabled service, provider, address, model and selected key name. Keys live in Obsidian secret storage on this device; have me select the key in settings. Check the plugin’s request and error handling for a missing or rejected key, balance or quota, an unknown model, rate limiting, a timeout or an unreachable endpoint. Do not reset data.json or the service list.
To confirm the fix, have me press Test for the same service. It should finish with a successful connection message. I will run this check because it sends a short request that may use provider quota. If it fails, report the remaining diagnostic error.
```

## Receipt images are not read

```text
AI Accounting reads my note text but misses its embedded receipt image, or says no service reads images. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-accounting/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check that an enabled service has Reads images turned on and uses a model that accepts images. Inspect the plugin’s embedded-image collection and service selection. It supports ![[…]] and ![](…) images, up to six per note. Ask me to confirm that the image displays in the named note; do not open attachments outside the allowed folder. Check whether a saved draft is being reused before attempting another request. Keep existing drafts.
To confirm the fix, have me choose a note containing one made-up receipt image that has no existing draft, and run Read the current note into the ledger. I will run the request because it sends the note and image to my enabled services. The review should show the image and a draft matching its date, amount and currency. Have me close the dialog without recording: the draft should remain under To review, and no ledger row should be added.
```

## A missing exchange rate blocks recording

```text
AI Accounting cannot record an expense because its exchange rate is unavailable. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-accounting/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Check the transaction currency, report currency and date I provide, rates_cache.json in the plugin folder, and the plugin’s handling of an unavailable frankfurter.app rate. Check the manual-rate dialog and the last-rate suggestion. Rates must be positive. Do not invent a rate, clear the cache or reset settings. Keep the original amount, currency and draft.
To confirm the fix, have me retry the affected draft. When no rate is available, a manual-rate dialog should open. Cancelling should leave the draft and write no ledger row. I will then enter a rate I have checked and confirm recording myself. The ledger should contain the original amount, currency, chosen rate and matching converted amount. All note changes in this check are performed by me through the plugin.
```

## The Bases Ledger view is missing or empty

```text
AI Accounting’s Ledger view is missing from Bases, or it shows no amounts. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/ai-accounting/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Stop and ask before deleting anything.
Ask me to confirm that Obsidian is 1.13 or later and that the core Bases plugin is enabled; do not access or change that plugin. Check AI Accounting’s manifest, view registration and amount-property handling. Monthly ledgers use the numeric total_expense property; other notes need a numeric amount property selected in the view options. Ask me for the view’s filters and selected property. You may read the one note I name to check its value, but may not change notes or the base file.
To confirm the fix, have me open my base and select Ledger. If I just enabled Bases, allow a few seconds for registration. I will select the correct numeric amount property and check that a note with a known value appears with that amount, that the total and average match the displayed rows, and that grouped rows show the correct subtotal.
```

[Open an issue](https://github.com/Rexxall/obsidian-ai-accounting/issues/new/choose).
