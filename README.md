# hermes-mini — دستیار وظایف فارسی روی Cloudflare

A serverless Persian task assistant for **Telegram**, for **multiple whitelisted users**.
You talk to it like a human — it understands free-form Persian, manages tasks in D1, reminds you
before important deadlines, tracks streaks, and runs **entirely on the Cloudflare free plan**
(per the *Cloud Computing Course Project* spec).

> «میان‌ترم درس رایانش ابری دوشنبه هفته دیگه ساعت ۱۰ دارم» → ثبت کار + یادآوری دو روز قبل
> «جلسه فردا کنسل شد» → حذف کار
> «کارام چیه؟» → فهرست به تفکیک امروز / فردا / هفته آینده
> «سلام» → گفتگوی عادی با حافظه‌ی مکالمه

---

## Architecture (Phase 1)

```
 User (Telegram) ──webhook──▶ Telegram Bot API ──POST / (secret header)──▶ Cloudflare Worker
                                                                               │
                                                                               ├──▶ Gemini API
                                                                               │    (round-robin
                                                                               │     over N keys)
                                                                               └──▶ D1 (SQLite)
                                                                                    tasks / memory / meta
                                                                cron */5* * * * ──▶ reminders + daily list
```

| Decision | Why |
|---|---|
| **Webhook, not polling** | The worker runs only when an event arrives — no idle cost, no keep-alive process; FaaS-native. Polling would need a persistent consumer. |
| **FaaS for this workload** | Traffic is a few messages a day; a VM would be 100% idle. Workers bill per request (free tier: 100k/day) — effectively $0. |
| **D1, not KV** | Tasks need real queries: list by user & due date, find reminders due in a window, fuzzy title matching, id-based updates. KV is a whole-value lookup with no queryability. D1 = SQLite with indexes and transactions. |
| **Where state lives** | Everything in D1 — tasks, rolling chat memory (last 12 turns), and the Gemini key-rotation cursor. The worker is stateless; any isolate can serve any request. |
| **Tehran time** | The runtime has no timezone. Wall-clock strings (`due_date`, `due_time`) are Tehran-local; comparisons use epoch-ms. Tehran = **UTC+03:30 fixed** (Iran abolished DST in 2022) — `tehranNow()` shifts `Date.now()` by +210 min and reads UTC fields. Display uses Jalali dates (بundled conversion, no library). |
| **Single worker file** | All logic in `src/worker.ts` (~800 lines) per the hard constraint — no frameworks. |

## Layout

```
src/worker.ts            all logic: webhook auth → Gemini → validate → D1 → reply; cron handlers
migrations/0001_init.sql D1 schema (tasks / memory / meta) — kept separate from code (R7)
wrangler.toml            config: D1 binding, cron trigger, vars (secrets are NOT here)
scripts/set-webhook.mjs  registers the webhook with the secret token
tests/quick-test.mts     38 logic tests (Jalali dates, validation contract, round-robin parsing)
.dev.vars.example        template for local secrets — copy to .dev.vars (git-ignored)
```

## Secrets (never in the repo)

| Secret | What | Where to get it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `TELEGRAM_WEBHOOK_SECRET` | Any long random string; Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token` | you invent it |
| `GEMINI_KEYS` | JSON array of 1–10 Gemini API keys: `["k1","k2",…]` | [aistudio.google.com](https://aistudio.google.com) → Get API key (one key per Google Cloud project — 10 keys = 10× free quota) |

Non-secret vars live in `wrangler.toml`: `TEHRAN_DAILY_HOUR` (morning list hour), `GEMINI_MODEL`
(default `gemini-3.5-flash-lite`), and `ALLOWED_USER_ID` — a **bootstrap** id that is auto-added
to the whitelist on its first message.

**User management** — the real whitelist is the D1 `users` table (platform + user_id):

```bash
npx wrangler d1 execute hermes-mini --remote --command \
  "INSERT OR IGNORE INTO users (platform,user_id,name,added_at,active) VALUES ('telegram',<ID>,'name',strftime('%s','now')*1000,1)"
```

## Deploy — step by step

Requires Node 20+. Then:

```bash
npm install

# 1. Log in to Cloudflare (opens a browser)
npx wrangler login

# 2. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create hermes-mini

# 3. Create the tables (remote)
npm run db:migrate:remote

# 4. Put your Telegram user id in wrangler.toml → [vars] ALLOWED_USER_ID
#    (find it: message @userinfobot in Telegram)

# 5. Secrets — one command each, paste the value when prompted
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GEMINI_KEYS        # e.g. ["AIza…1","AIza…2", … up to 10]

# 6. Deploy
npm run deploy                              # prints your URL: https://hermes-mini.<your-sub>.workers.dev

# 7. Register the webhook (reads the token/secret from env or .dev.vars)
node scripts/set-webhook.mjs https://hermes-mini.<your-sub>.workers.dev

# 8. Watch live logs during the demo (Phase 5)
npm run tail
```

**Verify:** `curl https://hermes-mini.<your-sub>.workers.dev/health` → `ok`.
POSTing to `/` without the secret header → `403`. Messages from any other Telegram user → silently ignored.

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill with your real keys
npm run db:migrate:local
npm run dev                       # http://127.0.0.1:8787
npm test                          # 38 logic tests, no network needed
```

Simulate a webhook locally:

```bash
curl -X POST http://127.0.0.1:8787/ \
  -H "content-type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <your secret>" \
  -d '{"message":{"message_id":1,"from":{"id":<your id>},"chat":{"id":<your id>},"text":"سلام","date":1700000000}}'
```

Trigger the cron locally: `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"`.

## Intelligence layer (Phase 4)

1. Every message is sent to Gemini with: the current **Tehran datetime (Gregorian + Jalali +
   weekday)**, the numbered list of open tasks, and the last 12 chat turns.
2. The model must return **one line of JSON**: `{action, task, date, time, remind_minutes,
   category, scope, target_ids, target_query, all, reply}` — enforced via
   `responseMimeType: application/json`.
3. Output is **validated** (action ∈ {add, done, undone, del, edit, search, stats, list, chat},
   date format & not in the past, remind ≤ 30 days, add needs a title, done/del needs a target,
   edit needs a target AND a change…). On failure the worker retries once with the error shown to
   the model; if it still fails → **safe fallback**: a Persian apology is sent and **nothing is
   written to D1** (R3).
4. `done`/`del`/`edit` resolve targets by id (from the numbered list) or fuzzy title match
   (Persian-normalized: ي→ی، ك→ک، Persian digits, ZWNJ). Ambiguous matches make the bot **ask
   which one**, and ids are looked up across all statuses so «شماره‌ی ۳ رو حذف کن» works even for
   already-done tasks.
5. Reminders: for important tasks the model sets `remind_minutes` (e.g. 2880 = two days before).
   The offset is stored, so **editing the due time re-derives the reminder automatically**. The
   cron (`*/5 * * * *`) fires anything due on the right messenger, and once a day at
   `TEHRAN_DAILY_HOUR` Tehran time sends every user their list + streak (**bonus, +0.25**).
6. **Round-robin:** keys rotate on every call, the cursor persists in D1 (survives restarts), and
   failures are classified: dead key (400/401/403) → next key; overload (404/429/5xx) → **next
   model** in the chain `GEMINI_MODEL → gemini-3.6-flash → gemini-flash-latest`, under a 14s hard
   deadline with per-call 8s timeouts.
7. 3.x models run with `thinkingLevel: "low"` — benchmarked 11.2s → 3.6s per decision with no
   quality loss on the task contract.

## Multi-user

- The whitelist is the D1 `users (platform, user_id)` table; strangers are rejected **silently**.
- Tasks are scoped `(platform, user_id)` — the same numeric id on two messengers never collides.
- Reminders and the daily cron send each user their list on **their own platform**.

## Free-plan budget (Phase 6 seed)

- **Workers free:** 100k requests/day, 10ms CPU per invocation — one user is ~nothing.
- **D1 free:** 5M rows read / 100k rows written / 5 GB per day — each message is ~10 reads + ~5 writes.
- **Cron:** 1 trigger (`*/5 * * * *`) of the allowed 5.
- **Gemini free tier:** quota is **per key** — 10 keys = 10× the requests. At 10k users × ~20
  msg/day, workers/D1 still fit; Gemini becomes the paid bottleneck (~$0.01–0.03 / 1k calls on
  flash models) or requires raised quotas.

## Pitfalls (from the spec — read before the demo)

- **Bot silent, no requests in logs** → check the Zero Trust-related step in the CF dashboard.
- **Your browser can't open the workers.dev URL but Telegram works** → normal; workers.dev is
  filtered from Iran. Test with curl, not the browser.
- **Deploy error 10405** → a domain prerequisite wasn't created yet.
- **Telegram redelivers the same message** → your worker returned non-200; this worker answers 200
  immediately and processes in `waitUntil` precisely to avoid that.

## Demo checklist (the review's hard messages)

- [ ] «شیر بخر» → task added
- [ ] «شیر رو خریدم» → ticked off
- [ ] «کارام چیه؟» → grouped list with ids
- [ ] «همه رو حذف کن» → all deleted
- [ ] «شماره‌ی ۳ رو حذف کن» → id 3 deleted
- [ ] «جلسه‌های این هفته رو بیار» → list filtered by week
- [ ] ambiguous sentence → clarification question, **no bad data**
- [ ] (unplug a Gemini key → bot still answers on the next key)
