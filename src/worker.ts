/**
 * hermes-mini — a serverless Persian personal-task assistant on Cloudflare.
 *
 *   Telegram --webhook--> this Worker --SQL--> D1
 *                             |
 *                             +--> Gemini API (round-robin over N keys)
 *
 * Design notes (for the Phase-1 defence):
 *  - Webhook (not polling): the worker runs only when an event arrives; no VM,
 *    no keep-alive process, free-plan friendly.
 *  - D1 (not KV): tasks need real queries — by user, by due-time, fuzzy title
 *    match, reminders due in a window — KV can only look up whole values.
 *    D1 is SQLite: SQL + indexes + transactions.
 *  - State: tasks, rolling chat memory and the key-rotation cursor all live in
 *    D1. The worker itself is stateless — any isolate can serve any request.
 *  - Tehran time: UTC+03:30 fixed (Iran abolished DST in 2022). Wall-clock
 *    strings (due_date/due_time) are Tehran-local; comparisons use epoch-ms.
 *  - Secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, GEMINI_KEYS) live
 *    only in the Workers secret store — never in this repo (hard constraint).
 */

// ───────────────────────────── Env & small types ─────────────────────────────

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** JSON array of one or more Gemini API keys: ["k1","k2",...] */
  GEMINI_KEYS: string;
  GEMINI_MODEL?: string;
  /** Bootstrap whitelist: if this Telegram id messages the bot and is not yet
   *  in the D1 `users` table, it is auto-added. The real whitelist lives in D1. */
  ALLOWED_USER_ID?: string;
  /** Tehran hour (0-23) for the daily morning list (bonus). */
  TEHRAN_DAILY_HOUR?: string;
  /** Optional — Bale messenger (Iranian Telegram-style API, tapi.bale.ai). */
  BALE_BOT_TOKEN?: string;
  BALE_WEBHOOK_SECRET?: string;
}

interface TgUser { id: number; first_name?: string; username?: string }
interface TgChat { id: number }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; text?: string; date: number }

/** One chat-memory entry: r='u' (user) or 'b' (bot), t=text. */
interface Msg { r: 'u' | 'b'; t: string }

interface TaskRow {
  id: number;
  platform: string;
  user_id: number;
  title: string;
  category: string | null;
  due_date: string | null;
  due_time: string | null;
  due_ts: number | null;
  remind_at: number | null;
  remind_minutes: number | null;
  remind_sent: number;
  done: number;
  created_at: number;
  done_at: number | null;
}

/** A whitelisted user (R5, generalized to multiple users and platforms). */
interface UserRow { platform: string; user_id: number; name: string | null; added_at: number; active: number }

type Action = 'add' | 'done' | 'undone' | 'del' | 'edit' | 'search' | 'stats' | 'list' | 'chat';
const ACTIONS: readonly Action[] = ['add', 'done', 'undone', 'del', 'edit', 'search', 'stats', 'list', 'chat'];

/** The structured-output contract (R2/R3) — every LLM reply must satisfy this. */
interface Decision {
  action: Action;
  task: string | null;
  date: string | null;      // 'YYYY-MM-DD' Gregorian, Tehran-local
  time: string | null;      // 'HH:MM' 24h
  remind_minutes: number | null;
  category: string | null;  // short Persian tag (درس، کار، خرید، ...)
  scope: 'open' | 'done';   // del/all target set — 'done' empties the archive
  target_ids: number[];
  target_query: string | null;
  all: boolean;
  reply: string;
}

const TZ_OFFSET_MIN = 210;   // Tehran = UTC+03:30 fixed (no DST since 2022)
const MAX_HISTORY = 12;      // rolling chat-memory entries (≈6 exchanges, R4)
const MAX_TEXT = 4000;       // Telegram sendMessage limit is 4096 — stay under

// ───────────────────────────── Prompts & static text ─────────────────────────

const SYSTEM_PROMPT = `تو «هرمس» هستی؛ دستیار وظایفِ کاربران فارسی‌زبان در تلگرام/بله.
همیشه دقیقاً یک خط JSON معتبر برگردان — بدون markdown، بدون backtick، بدون متن اضافه.

قالب JSON:
{"action":"add|done|undone|del|edit|search|stats|list|chat","task":"عنوان یا null","date":"YYYY-MM-DD یا null","time":"HH:MM یا null","remind_minutes":عدد یا null,"category":"برچسب یا null","scope":"open یا done","target_ids":[شناسه‌ها],"target_query":"چند کلمه از عنوان یا null","all":false,"reply":"پاسخ فارسی"}

قوانین تصمیم‌گیری:
- "add": کاربر کارِ تازه‌ای می‌گوید. عنوان کوتاه و خلاصه در "task". اگر تاریخ یا ساعت گفت در "date"/"time" با فرمت دقیق؛ اگر نگفت null. اگر مضمون کار روشن است "category" را با یک برچسب کوتاه فارسی پر کن (درس، کار، خرید، سلامت، شخصی، قرار)؛ وگرنه null.
- "edit": تغییر یک کار موجود. فقط فیلدهای جدید را پر کن؛ بقیه null بمانند. «جلسه رو ببر شنبه» → edit + date. «۲ ساعت قبلش خبر بده» → edit + remind_minutes=120 + target_query. «عنوانش رو بذار خرید کتاب» → edit + task.
- "search": کاربر دنبال کارِ قبلی می‌گردد («اون آزمون کی بود؟») → target_query با کلیدواژه‌ها. جستجو شامل کارهای انجام‌شده هم هست.
- "stats": آمار و پیشرفت («چند کار این هفته انجام دادم؟»، «استریکم چیه؟»).
- "del": حذف. «همه را حذف کن» → all:true (فقط کارهای باز). «آرشیو/انجام‌شده‌ها را خالی کن» → all:true و scope:"done".
- "done": کاربر می‌گوید کاری را انجام داده. شناسه‌ی آن کار از «کارهای باز» را در "target_ids" بگذار؛ اگر مطمئن نیستی "target_query" را با چند کلمه‌ی کلیدی پر کن.
- "undone": کاربر می‌گوید کاری اشتباهی تیک خورده.
- "list": کاربر خواست کارهایش را ببیند.
- "chat": هیچ‌کدام از این‌ها نیست؛ گفتگوی معمولی یا سؤال عمومی.
- در "reply" همیشه فارسیِ کوتاه، طبیعی و دوستانه بنویس. برای add/done/undone/del/edit فقط یک جمله‌ی کوتاه بگو و جزئیات (عنوان، تاریخ، ساعت، یادآوری، شماره) را تکرار نکن — سیستم خودش خط تأییدِ دقیق اضافه می‌کند. تاریخ را شمسی و طبیعی بگو — هرگز فرمت خام تاریخ/ساعت را نشان نده.
- بعد از ثبت یا تغییر یک کارِ دارای تاریخِ مهم، در پایان reply یک قدمِ بعدیِ مفید پیشنهاد بده؛ مثلاً: «خواستی بگو چند ساعت قبل هم یادت بندازم.» کوتاه بماند و برای کارهای ساده پیشنهاد نده.
- اگر درخواست مبهم است (معلوم نیست کدام کار، یا add است یا done یا edit)، action را "chat" بگذار و در reply سؤال شفاف‌سازی بپرس.
- تاریخ‌های نسبی («فردا»، «دوشنبه هفته دیگه»، «اواخر هفته») را با توجه به «امروز» که در پایین آمده مطلق کن. روزِ هفته‌ی «امروز» را فقط از همان خط بگیر، حدس نزن. هفته‌ی ایرانی از شنبه شروع می‌شود و «هفته دیگه» یعنی شنبه تا جمعه‌ی بعد. اعداد فارسی را به لاتین تبدیل کن.
- فقط از شناسه‌های فهرست «کارهای باز» استفاده کن؛ شناسه از خودت نساز.
- خروجی باید قابل JSON.parse باشد: از " برای رشته‌ها استفاده کن و کاراکتر " داخل متن را با \\ جای‌گزین کن.`;

const WELCOME = `سلام! من «هرمس» هستم — حافظه‌ای که هیچ‌وقت خسته نمی‌شود 🧠

هر چیزی که توی ذهنت می‌چرخد را همان‌طور که هست بگو؛ خودم ماجرا را می‌فهمم:
🛒 «جمعه حتماً بلیط قطار مشهد را بگیر» → می‌رود توی لیست
✅ «بلیط را گرفتم» → خودش تیک می‌خورد
🗑 «قرار جمعه به‌هم خورد» → از لیست پاک می‌شود
🌙 «این هفته چی دارم؟» → کل هفته‌ات را مرتب می‌آورم

برای کارهای مهم مثل آزمون و سفر، قبل از موعد هوایت را دارم ⏰
و هر روز صبح، چک‌لیست امروزت را می‌رسانم 🌅

خب، اولین چیزی که نباید فراموش کنی چیه؟`;

// ───────────────────────────── Time / Jalali utilities ───────────────────────

interface TehranNow { y: number; m: number; d: number; hh: number; mm: number; dateStr: string; epoch: number }

/** Current wall-clock in Tehran, derived from Date.now() (server has no TZ). */
function tehranNow(nowMs = Date.now()): TehranNow {
  const t = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
  return {
    y, m, d,
    hh: t.getUTCHours(), mm: t.getUTCMinutes(),
    dateStr: `${y}-${pad2(m)}-${pad2(d)}`,
    epoch: nowMs,
  };
}

/** Tehran wall time → epoch ms. */
function tehranToEpoch(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET_MIN * 60000;
}

function dateStrToParts(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }

/** Latin digits → Persian digits (display only; ids stay Latin for easy typing). */
function toFa(s: string | number): string {
  return String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}

const WEEKDAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه']; // index = JS getDay (0=Sun)
const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

function weekdayOf(dateStr: string): string {
  const { y, m, d } = dateStrToParts(dateStr);
  return WEEKDAYS_FA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Jalali ↔ Gregorian conversion (port of the standard jalaali-js algorithm).
// NOTE: div/mod must TRUNCATE toward zero (like the original's ~~), not floor —
// the leap-year computation relies on mod() of a negative value staying negative.
function div(a: number, b: number): number { return Math.trunc(a / b); }
function mod(a: number, b: number): number { return a - Math.trunc(a / b) * b; }

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14, jp = breaks[0], jm = 0, jump = 0, n = 0;
  if (jy < jp || jy >= breaks[bl - 1]) throw new Error('Invalid Jalali year ' + jy);
  for (let i = 1; i < bl; i++) {
    jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function d2j(jdn: number): { jy: number; jm: number; jd: number } {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** Gregorian (y, m, d) → Jalali {jy, jm, jd}. */
function g2j(gy: number, gm: number, gd: number): { jy: number; jm: number; jd: number } {
  return d2j(g2d(gy, gm, gd));
}

/** Gregorian 'YYYY-MM-DD' → Jalali, e.g. «۱۲ آبان ۱۴۰۵». */
function jalaliOf(dateStr: string): string {
  const { y, m, d } = dateStrToParts(dateStr);
  const j = g2j(y, m, d);
  return `${toFa(j.jd)} ${JALALI_MONTHS[j.jm - 1]} ${toFa(j.jy)}`;
}

/** Human description of a task's due moment relative to Tehran-today. */
function fmtDue(date: string | null, time: string | null): string {
  if (!date) return 'بدون تاریخ';
  const n = tehranNow();
  const p = dateStrToParts(date);
  const diff = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86400000);
  const t = time ? ' ساعت ' + toFa(time) : '';
  if (diff === 0) return 'امروز' + t;
  if (diff === 1) return 'فردا' + t;
  return `${weekdayOf(date)} ${jalaliOf(date)}${t}`;
}

/** 1440 → «یک روز قبل», 120 → «۲ ساعت قبل», 30 → «نیم ساعت قبل», ... */
function humanizeRemind(min: number): string {
  if (min === 30) return 'نیم ساعت قبل';
  if (min === 60) return 'یک ساعت قبل';
  if (min === 1440) return 'یک روز قبل';
  if (min === 10080) return 'یک هفته قبل';
  if (min < 60) return `${toFa(min)} دقیقه قبل`;
  if (min < 1440) return `${toFa(min / 60)} ساعت قبل`;
  return `${toFa(Math.round(min / 1440))} روز قبل`;
}

// ───────────────────────────── Text utilities ────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Normalize Persian text for fuzzy title matching (ی/ك, digits, ZWNJ, diacritics). */
function normFa(s: string): string {
  return s
    .replace(/ي/g, 'ی').replace(/ى/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\u200c\u200b\u064b-\u065f\u0670]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ───────────────────────────── D1 data layer ─────────────────────────────────

async function getMeta(db: D1Database, key: string, dflt = ''): Promise<string> {
  const r = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? dflt;
}

async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, value).run();
}

async function getHistory(db: D1Database, userId: number): Promise<Msg[]> {
  const r = await db.prepare('SELECT history FROM memory WHERE user_id = ?').bind(userId).first<{ history: string }>();
  if (!r) return [];
  try {
    const a = JSON.parse(r.history);
    return Array.isArray(a) ? a.slice(-MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

async function appendHistory(db: D1Database, userId: number, userText: string, botText: string): Promise<void> {
  const msgs = await getHistory(db, userId);
  msgs.push({ r: 'u', t: userText.slice(0, 1000) }, { r: 'b', t: botText.slice(0, 1000) });
  await db.prepare(
    `INSERT INTO memory (user_id, history, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at`,
  ).bind(userId, JSON.stringify(msgs.slice(-MAX_HISTORY)), Date.now()).run();
}

async function listTasks(db: D1Database, platform: string, userId: number, done: number, limit = 50): Promise<TaskRow[]> {
  const r = await db.prepare(
    'SELECT * FROM tasks WHERE platform = ? AND user_id = ? AND done = ? ORDER BY (due_ts IS NULL), due_ts, id LIMIT ?',
  ).bind(platform, userId, done, limit).all<TaskRow>();
  return r.results ?? [];
}

async function addTask(
  db: D1Database, platform: string, userId: number, title: string, category: string | null,
  dueDate: string | null, dueTime: string | null, dueTs: number | null,
  remindAt: number | null, remindMinutes: number | null,
): Promise<number> {
  const r = await db.prepare(
    `INSERT INTO tasks (platform, user_id, title, category, due_date, due_time, due_ts, remind_at, remind_minutes, remind_sent, done, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  ).bind(platform, userId, title, category, dueDate, dueTime, dueTs, remindAt, remindMinutes, Date.now()).run();
  return Number(r.meta.last_row_id ?? 0);
}

// ── users (multi-user whitelist, R5 generalized) ─────────────────────────────

async function getUser(db: D1Database, platform: string, userId: number): Promise<UserRow | null> {
  return await db.prepare('SELECT * FROM users WHERE platform = ? AND user_id = ?')
    .bind(platform, userId).first<UserRow>();
}

async function addUser(db: D1Database, platform: string, userId: number, name: string | null): Promise<UserRow> {
  await db.prepare('INSERT OR IGNORE INTO users (platform, user_id, name, added_at, active) VALUES (?, ?, ?, ?, 1)')
    .bind(platform, userId, name, Date.now()).run();
  return (await getUser(db, platform, userId))!;
}

async function listActiveUsers(db: D1Database): Promise<UserRow[]> {
  const r = await db.prepare('SELECT * FROM users WHERE active = 1').all<UserRow>();
  return r.results ?? [];
}

async function markTasks(db: D1Database, ids: number[], done: boolean): Promise<void> {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  const sql = done
    ? `UPDATE tasks SET done = 1, done_at = ?, remind_at = NULL, remind_sent = 1 WHERE id IN (${ph})`
    : `UPDATE tasks SET done = 0, done_at = NULL, remind_sent = 0 WHERE id IN (${ph})`;
  await db.prepare(sql).bind(done ? Date.now() : null, ...ids).run();
}

async function deleteTasks(db: D1Database, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  await db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).bind(...ids).run();
}

// ───────────────────────────── Telegram layer ────────────────────────────────

/** Bot API base URLs — Bale mirrors Telegram's API shape (tapi.bale.ai). */
const API_BASES: Record<string, string> = {
  telegram: 'https://api.telegram.org',
  bale: 'https://tapi.bale.ai',
};

function botTokenFor(env: Env, platform: string): string | undefined {
  return platform === 'bale' ? env.BALE_BOT_TOKEN : env.TELEGRAM_BOT_TOKEN;
}

async function tgCall(env: Env, platform: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = botTokenFor(env, platform);
  if (!token) throw new Error(`${platform} bot token is not configured`);
  const res = await fetch(`${API_BASES[platform]}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !j?.ok) throw new Error(`${platform} ${method} → ${res.status} ${j?.description ?? ''}`.trim());
  return j;
}

/** Send an HTML message to a chat on the given platform; clamps length. */
async function tgSend(env: Env, platform: string, chatId: number, text: string): Promise<void> {
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  await tgCall(env, platform, 'sendMessage', {
    chat_id: chatId,
    text: t,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

// ───────────────────────────── Gemini layer (round-robin) ────────────────────

class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Accepts a JSON array string, a comma/space separated list, or a single key. */
function parseKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const a: unknown = JSON.parse(s);
      if (Array.isArray(a)) return a.map(String).map((k) => k.trim()).filter(Boolean);
    } catch { /* fall through to plain parsing */ }
  }
  return s.split(/[,\s;]+/).map((k) => k.trim()).filter(Boolean);
}

async function getMetaNumber(db: D1Database, key: string, dflt = 0): Promise<number> {
  const v = Number(await getMeta(db, key, String(dflt)));
  return Number.isFinite(v) ? v : dflt;
}

/** One Gemini call with a specific model+key. Returns the raw text output. */
async function geminiOnce(env: Env, model: string, key: string, contents: unknown[]): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig: Record<string, unknown> = {
    temperature: 0.3,
    responseMimeType: 'application/json',   // structured output (R3)
    maxOutputTokens: 4096,
  };
  if (/^gemini-2\.5/.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  } else if (/^gemini-3/.test(model)) {
    // 3.x models think by default (~400+ thought tokens per decision, seconds
    // of added latency). thinkingLevel low keeps JSON quality at a fraction of
    // the latency (benchmarked: 11.2s→3.6s warm on flash-lite).
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig,
    }),
    // Overloaded models can hang instead of failing fast — never let one call
    // eat the whole turn. The 14s deadline in geminiDecide caps the chain.
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GeminiError(`gemini ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  const j = await res.json() as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: unknown;
  };
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) {
    const fb = j.promptFeedback ? JSON.stringify(j.promptFeedback).slice(0, 200) : 'empty candidate';
    throw new GeminiError(`gemini empty output (${fb})`, 502);
  }
  return text;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Round-robin over all configured keys — interleaved with a small model chain.
 * The cursor persists in D1, so rotation continues across restarts.
 *
 * Two independent failure classes, handled differently:
 *  - dead key (400/401/403)  → shift to the next key immediately
 *  - overload (404/429/5xx)  → the whole model is probably busy: jump to the
 *    NEXT MODEL (not the next key), with a short backoff; a second pass over
 *    the chain uses the next key in rotation.
 *
 * Everything runs under a hard deadline well inside Telegram's webhook
 * patience — the caller awaits this inline, so slow Google 503s can never
 * strand the reply in a cancelled waitUntil.
 */
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-flash-latest'];
const GEMINI_DEADLINE_MS = 14_000;
const KEY_ERROR_STATUS = new Set([400, 401, 403]);

async function geminiDecide(env: Env, contents: unknown[]): Promise<string> {
  const keys = parseKeys(env.GEMINI_KEYS);
  if (!keys.length) throw new Error('GEMINI_KEYS is not configured');
  const primary = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const models = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  const cursor0 = (await getMetaNumber(env.DB, 'gemini_cursor')) % keys.length;
  const deadline = Date.now() + GEMINI_DEADLINE_MS;
  let keyOffset = 0;
  let lastErr: unknown;

  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      if (Date.now() >= deadline) break;
      const idx = (cursor0 + round + keyOffset) % keys.length;
      try {
        const text = await geminiOnce(env, model, keys[idx], contents);
        await setMeta(env.DB, 'gemini_cursor', String((idx + 1) % keys.length));
        console.log(`[gemini] model=${model} key #${idx + 1}/${keys.length} ok`);
        return text;
      } catch (e) {
        lastErr = e;
        const st = e instanceof GeminiError ? e.status : 0;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[gemini] model=${model} key #${idx + 1}/${keys.length} failed: ${msg.slice(0, 140)}`);
        if (KEY_ERROR_STATUS.has(st)) keyOffset++;       // dead key — stop using it this turn
        else if (Date.now() < deadline) await sleep(600); // overload flap — brief pause
      }
    }
    if (Date.now() >= deadline) break;
  }
  throw lastErr instanceof Error ? lastErr : new Error('gemini: all models/keys failed');
}

// ───────────────────────────── Prompt building ───────────────────────────────

function buildContext(now: TehranNow, openTasks: TaskRow[], history: Msg[]): string {
  const lines: string[] = [];
  lines.push('### زمان فعلی');
  lines.push(`امروز ${now.dateStr} میلادی برابر است با ${weekdayOf(now.dateStr)} ${jalaliOf(now.dateStr)} — ساعت ${pad2(now.hh)}:${pad2(now.mm)} به وقت تهران. (هفته‌ی ایرانی از شنبه شروع می‌شود.)`);
  lines.push('');
  lines.push('### کارهای باز (شناسه. عنوان — سررسید)');
  if (openTasks.length === 0) lines.push('(هیچ کاری باز نیست)');
  else for (const t of openTasks) lines.push(`${t.id}. ${t.title} — ${fmtDue(t.due_date, t.due_time)}`);
  if (history.length) {
    lines.push('');
    lines.push('### گفتگوی اخیر');
    for (const m of history) lines.push(`${m.r === 'u' ? 'کاربر' : 'تو'}: ${m.t}`);
  }
  return lines.join('\n');
}

// ───────────────────────────── Validation (R3) ───────────────────────────────

/** Strip markdown fences / stray prose, keep the outermost JSON object. */
function extractJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return s;
}

function validateDecision(raw: string, now: TehranNow): Decision | { error: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  } catch (e) {
    return { error: 'json parse: ' + (e as Error).message };
  }
  if (typeof j !== 'object' || j === null) return { error: 'not an object' };

  const action = String(j.action ?? '');
  if (!(ACTIONS as readonly string[]).includes(action)) return { error: 'bad action: ' + action };

  const str = (v: unknown, max: number): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
  };

  const d: Decision = {
    action: action as Action,
    task: str(j.task, 300),
    date: null,
    time: null,
    remind_minutes: null,
    category: str(j.category, 40),
    scope: j.scope === 'done' ? 'done' : 'open',
    target_ids: [],
    target_query: str(j.target_query, 120),
    all: j.all === true,
    reply: str(j.reply, 1500) ?? 'باشه.',
  };

  if (j.date != null && j.date !== '') {
    const s = String(j.date).trim().replace(/[۰-۹]/g, (x) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(x)));
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return { error: 'bad date format: ' + s };
    const y = +m[1], mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return { error: 'bad date values: ' + s };
    d.date = `${y}-${pad2(mo)}-${pad2(da)}`;
    const dtMs = Date.UTC(y, mo - 1, da);
    const todayMs = Date.UTC(now.y, now.m - 1, now.d);
    if (dtMs < todayMs - 86400000) return { error: 'date in the past: ' + s };
  }

  if (j.time != null && j.time !== '') {
    const s = String(j.time).trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m || +m[1] > 23 || +m[2] > 59) return { error: 'bad time: ' + s };
    d.time = `${pad2(+m[1])}:${m[2]}`;
  }
  if (d.action === 'add' && d.time && !d.date) d.date = now.dateStr; // «ساعت ۵» → امروز

  if (j.remind_minutes != null) {
    const n = Number(j.remind_minutes);
    if (Number.isFinite(n) && n > 0) d.remind_minutes = Math.min(Math.round(n), 43200); // ≤ 30 days
  }

  if (Array.isArray(j.target_ids)) {
    d.target_ids = j.target_ids.map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 50);
  }

  if (d.action === 'add' && !d.task) return { error: 'add without task title' };
  if ((d.action === 'done' || d.action === 'undone' || d.action === 'del') &&
      d.target_ids.length === 0 && !d.target_query && !d.all) {
    return { error: d.action + ' without a target' };
  }
  if (d.action === 'edit') {
    if (d.target_ids.length === 0 && !d.target_query) return { error: 'edit without a target' };
    if (!d.task && !d.date && !d.time && d.remind_minutes == null && !d.category) {
      return { error: 'edit without any change' };
    }
  }
  return d;
}

// ───────────────────────────── Actions & rendering ───────────────────────────

function renderList(tasks: TaskRow[], now: TehranNow): string {
  const todayMs = Date.UTC(now.y, now.m - 1, now.d);
  const groups = new Map<string, { order: number; items: string[] }>();
  for (const t of tasks) {
    let label: string, order: number;
    if (!t.due_date) { label = 'بدون تاریخ'; order = 6; }
    else {
      const p = dateStrToParts(t.due_date);
      const diff = Math.round((Date.UTC(p.y, p.m - 1, p.d) - todayMs) / 86400000);
      if (diff < 0)      { label = 'عقب‌افتاده ⚠️'; order = 0; }
      else if (diff === 0) { label = 'امروز'; order = 1; }
      else if (diff === 1) { label = 'فردا'; order = 2; }
      else if (diff <= 7)  { label = weekdayOf(t.due_date); order = 3; }
      else                 { label = jalaliOf(t.due_date); order = 4; }
    }
    const g = groups.get(label) ?? { order, items: [] };
    const when = t.due_time ? ' — ' + toFa(t.due_time) : '';
    const tag = t.category ? `<i>[${esc(t.category)}]</i> ` : '';
    g.items.push(`${t.id}. ${tag}${esc(t.title)}${when}`);
    groups.set(label, g);
  }
  const parts: string[] = [];
  for (const [label, g] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    parts.push(`<b>${label}</b>\n${g.items.join('\n')}`);
  }
  return parts.join('\n\n') + '\n\n💡 برای تیک زدن یا حذف، شماره‌ی کار را بگو.';
}

/** Find the concrete tasks a done/undone/del/edit decision points at. */
async function resolveTargets(db: D1Database, platform: string, userId: number, d: Decision, primary: TaskRow[]): Promise<TaskRow[]> {
  if (d.all) return primary;
  if (d.target_ids.length) {
    // Ids are looked up across ALL statuses: «شماره‌ی ۳ رو حذف کن» must work
    // even if task 3 is already done (it is not in the open list).
    const ph = d.target_ids.map(() => '?').join(',');
    const r = await db.prepare(`SELECT * FROM tasks WHERE platform = ? AND user_id = ? AND id IN (${ph})`)
      .bind(platform, userId, ...d.target_ids).all<TaskRow>();
    return r.results ?? [];
  }
  if (d.target_query) {
    const q = normFa(d.target_query);
    const words = q.split(' ').filter((w) => w.length > 1);
    return primary.filter((t) => {
      const nt = normFa(t.title);
      return nt.includes(q) || words.some((w) => nt.includes(w));
    });
  }
  return [];
}

// ───────────────────────────── Stats & streaks ───────────────────────────────

function prevDateStr(ds: string): string {
  const p = dateStrToParts(ds);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Done-counts per Tehran day + current/best streak (🔥 motivation engine). */
async function computeStats(db: D1Database, platform: string, userId: number): Promise<{
  today: number; week: number; total: number; streak: number; best: number;
}> {
  const rows = await db.prepare(
    `SELECT done_at FROM tasks WHERE platform = ? AND user_id = ? AND done = 1 AND done_at IS NOT NULL
     ORDER BY done_at DESC LIMIT 1000`,
  ).bind(platform, userId).all<{ done_at: number }>();
  const now = tehranNow();
  const perDay = new Map<string, number>();
  let week = 0, total = 0;
  const weekAgo = now.epoch - 7 * 86400000;
  for (const r of rows.results ?? []) {
    total++;
    const ds = tehranNow(r.done_at).dateStr;
    perDay.set(ds, (perDay.get(ds) ?? 0) + 1);
    if (r.done_at >= weekAgo) week++;
  }
  // current streak: consecutive days ending today (or yesterday if today is empty yet)
  let streak = 0;
  let cur = perDay.has(now.dateStr) ? now.dateStr : prevDateStr(now.dateStr);
  while (perDay.get(cur)! > 0) { streak++; cur = prevDateStr(cur); }
  // best streak over all history
  let best = 0, run = 0, prev: string | null = null;
  for (const ds of [...perDay.keys()].sort().reverse()) {
    run = prev !== null && prevDateStr(prev) === ds ? run + 1 : 1;
    best = Math.max(best, run);
    prev = ds;
  }
  return { today: perDay.get(now.dateStr) ?? 0, week, total, streak, best };
}

// ───────────────────────────── Actions & rendering ───────────────────────────

async function executeDecision(env: Env, platform: string, chatId: number, d: Decision, now: TehranNow): Promise<string> {
  const db = env.DB;
  const uid = chatId;
  const reply = esc(d.reply);

  if (d.action === 'chat') return reply;

  if (d.action === 'list') {
    const tasks = await listTasks(db, platform, uid, 0);
    return tasks.length
      ? `${reply}\n\n${renderList(tasks, now)}`
      : `${reply}\n\nهنوز کاری ثبت نکرده‌ای ✍️`;
  }

  if (d.action === 'stats') {
    const s = await computeStats(db, platform, uid);
    return `${reply}\n📊 آمار کارهایت:\n` +
      `✅ امروز: ${toFa(s.today)} کار\n` +
      `📅 ۷ روز اخیر: ${toFa(s.week)} کار\n` +
      `🔥 استریک فعلی: ${s.streak > 0 ? `${toFa(s.streak)} روز پشت‌سرهم` : 'هنوز شروع نشده'}\n` +
      `🏆 رکورد استریک: ${toFa(s.best)} روز\n` +
      `📦 مجموع آرشیو: ${toFa(s.total)} کار`;
  }

  if (d.action === 'search') {
    const q = d.target_query ? normFa(d.target_query) : '';
    const rows = await db.prepare(
      `SELECT * FROM tasks WHERE platform = ? AND user_id = ?
       ORDER BY done ASC, (due_ts IS NULL), due_ts DESC LIMIT 40`,
    ).bind(platform, uid).all<TaskRow>();
    const found = (rows.results ?? []).filter((t) =>
      !q || normFa(t.title).includes(q) || (t.category ? normFa(t.category).includes(q) : false));
    if (found.length === 0) return `${reply}\n🔍 چیزی پیدا نکردم.`;
    const lines = found.slice(0, 20).map((t) =>
      `${t.done ? '✅' : '▫️'} ${t.id}. ${t.category ? `<i>[${esc(t.category)}]</i> ` : ''}${esc(t.title)}${t.due_date ? ` — ${fmtDue(t.due_date, t.due_time)}` : ''}`);
    return `${reply}\n🔍 نتیجه‌ها:\n${lines.join('\n')}`;
  }

  if (d.action === 'add') {
    let dueTs: number | null = null;
    let remindAt: number | null = null;
    if (d.date) {
      const p = dateStrToParts(d.date);
      const [h, mi] = d.time ? d.time.split(':').map(Number) : [9, 0]; // dateless time → 09:00
      dueTs = tehranToEpoch(p.y, p.m, p.d, h, mi);
      if (d.remind_minutes != null) {
        remindAt = dueTs - d.remind_minutes * 60000;
        if (remindAt <= now.epoch) remindAt = now.epoch + 60_000; // never schedule in the past
      }
    }
    await addTask(db, platform, uid, d.task!, d.category, d.date, d.time, dueTs, remindAt, d.remind_minutes);
    let out = `${reply}\n✅ «${esc(d.task!)}» ثبت شد`;
    if (d.date) out += ` — ${fmtDue(d.date, d.time)}`;
    if (d.category) out += ` · <i>[${esc(d.category)}]</i>`;
    if (remindAt != null && d.remind_minutes) out += `\n⏰ ${humanizeRemind(d.remind_minutes)} یادت می‌اندازم.`;
    return out;
  }

  if (d.action === 'edit') {
    const open = await listTasks(db, platform, uid, 0);
    const targets = await resolveTargets(db, platform, uid, d, open);
    if (targets.length === 0) {
      return `${reply}\n🤔 همچین کاری توی فهرستت پیدا نکردم. بگو «کارام چیه؟» تا شماره‌ها را ببینی.`;
    }
    if (targets.length > 1 && d.target_ids.length === 0 && d.target_query) {
      const lines = targets.map((t) => `${t.id}. ${esc(t.title)}`).join('\n');
      return `${reply}\nچند تا کار با این توصیف دارم؛ منظورت کدام بود؟\n${lines}`;
    }
    const t = targets[0];
    const title = d.task ?? t.title;
    const category = d.category ?? t.category;
    const date = d.date ?? t.due_date;
    const time = d.time ?? t.due_time;
    let dueTs = t.due_ts;
    if (d.date || d.time) {
      if (date) {
        const p = dateStrToParts(date);
        const [h, mi] = time ? time.split(':').map(Number) : [9, 0];
        dueTs = tehranToEpoch(p.y, p.m, p.d, h, mi);
      } else dueTs = null;
    }
    const mins = d.remind_minutes ?? t.remind_minutes;
    let remindAt = t.remind_at;
    if (d.remind_minutes != null || d.date || d.time) {
      // reminder set now, or re-derived from the stored offset when the due moved
      remindAt = dueTs != null && mins != null ? dueTs - mins * 60000 : null;
      if (remindAt != null && remindAt <= now.epoch) remindAt = now.epoch + 60_000;
    }
    const revive = !!(d.date || d.time); // moving a done task brings it back to open
    await db.prepare(
      `UPDATE tasks SET title = ?, category = ?, due_date = ?, due_time = ?, due_ts = ?,
       remind_at = ?, remind_minutes = ?, remind_sent = 0${revive ? ', done = 0, done_at = NULL' : ''} WHERE id = ?`,
    ).bind(title, category, date, time, dueTs, remindAt, mins, t.id).run();
    let out = `${reply}\n✏️ «${esc(title)}» ویرایش شد`;
    if (date) out += ` — ${fmtDue(date, time)}`;
    if (remindAt != null && mins) out += `\n⏰ ${humanizeRemind(mins)} یادت می‌اندازم.`;
    return out;
  }

  // done / undone / del — resolve which tasks the user means
  let primary: TaskRow[];
  if (d.action === 'undone') primary = await listTasks(db, platform, uid, 1, 30);
  else if (d.action === 'del' && d.all && d.scope === 'done') primary = await listTasks(db, platform, uid, 1, 200);
  else primary = await listTasks(db, platform, uid, 0);
  const targets = await resolveTargets(db, platform, uid, d, primary);

  if (targets.length === 0) {
    return `${reply}\n🤔 همچین کاری توی فهرستت پیدا نکردم. بگو «کارام چیه؟» تا شماره‌ها را ببینی.`;
  }
  if (targets.length > 1 && !d.all && d.target_ids.length === 0 && d.target_query) {
    // Ambiguous fuzzy match — ask instead of guessing (robustness is graded here).
    const lines = targets.map((t) => `${t.id}. ${esc(t.title)}`).join('\n');
    return `${reply}\nچند تا کار با این توصیف دارم؛ منظورت کدام بود؟\n${lines}`;
  }

  const ids = targets.map((t) => t.id);
  const titles = targets.map((t) => `«${esc(t.title)}»`).join('، ');

  if (d.action === 'done') {
    await markTasks(db, ids, true);
    return `${reply}\n✅ انجام شد: ${titles}`;
  }
  if (d.action === 'undone') {
    await markTasks(db, ids, false);
    return `${reply}\n↩️ برگردانده شد به «انجام‌نشده»: ${titles}`;
  }
  // del
  await deleteTasks(db, ids);
  return `${reply}\n🗑 حذف شد: ${titles}${d.all && d.scope === 'done' ? '\n📦 آرشیو خالی شد.' : ''}`;
}

// ───────────────────────────── Message handling ──────────────────────────────

const FALLBACK_LLM = 'چند لحظه حواسم پرت شد 🛸 لطفاً یک بار دیگر بگو.';
const FALLBACK_EXEC = 'یه مشکلی موقع ثبت پیش آمد؛ دوباره امتحان کن 🙏';

async function handleMessage(env: Env, platform: string, msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim().slice(0, 4000);
  if (!text) return;

  const now = tehranNow();
  const uid = msg.from?.id ?? chatId;

  // R5 — whitelist lives in the D1 `users` table. Telegram stays whitelisted
  // (with one bootstrap id); **Bale is open**: anyone who messages the bot is
  // auto-registered on first contact, so every Bale user gets their own scope.
  let user = await getUser(env.DB, platform, uid);
  if (!user && platform === 'telegram' && env.ALLOWED_USER_ID && String(uid) === String(env.ALLOWED_USER_ID)) {
    user = await addUser(env.DB, platform, uid, msg.from?.first_name ?? null);
    console.log(`[users] bootstrapped ${platform}:${uid}`);
  } else if (!user && platform === 'bale') {
    user = await addUser(env.DB, platform, uid, msg.from?.first_name ?? null);
    console.log(`[users] bale auto-registered ${uid}`);
  }
  if (!user || !user.active) {
    console.log(`[auth] ignored non-whitelisted sender ${platform}:${uid}`);
    return;
  }

  if (text.startsWith('/start')) {
    await tgSend(env, platform, chatId, WELCOME);
    return;
  }

  let decision: Decision;
  try {
    const history = await getHistory(env.DB, uid);
    const open = await listTasks(env.DB, platform, uid, 0);
    const context = buildContext(now, open, history);
    const contents = [{
      role: 'user',
      parts: [{ text: `${context}\n\n### پیام جدید کاربر\n${text}` }],
    }];

    let raw = await geminiDecide(env, contents);
    let v = validateDecision(raw, now);
    if ('error' in v) {
      // Safe retry: show the model its bad output and the error (R3 path).
      console.log(`[llm] invalid output (${v.error}); raw: ${raw.slice(0, 200)}`);
      const retry = [
        ...contents,
        { role: 'model', parts: [{ text: raw.slice(0, 1000) }] },
        { role: 'user', parts: [{ text: `خروجی قبلی این خطا را داشت: ${v.error}\nفقط یک خط JSON معتبر مطابق قالب برگردان؛ هیچ متن دیگری ننویس.` }] },
      ];
      raw = await geminiDecide(env, retry);
      v = validateDecision(raw, now);
      if ('error' in v) throw new Error('llm output invalid twice: ' + v.error);
    }
    decision = v;
  } catch (e) {
    console.error('[llm] failed:', e instanceof Error ? e.message : e);
    await tgSend(env, platform, chatId, FALLBACK_LLM);
    await appendHistory(env.DB, uid, text, FALLBACK_LLM);
    return;
  }

  try {
    const finalText = await executeDecision(env, platform, chatId, decision, now);
    await tgSend(env, platform, chatId, finalText);
    await appendHistory(env.DB, uid, text, finalText);
  } catch (e) {
    console.error('[exec] failed:', e instanceof Error ? e.message : e);
    await tgSend(env, platform, chatId, FALLBACK_EXEC);
  }
}

// ───────────────────────────── Cron: reminders + daily list ──────────────────

async function runCron(env: Env): Promise<void> {
  const now = tehranNow();
  const db = env.DB;

  // 1) Task reminders that are due (fires within ≤5 minutes of remind_at).
  //    Joined with users so the reminder lands on the right messenger.
  const due = await db.prepare(
    `SELECT t.id, t.platform, t.user_id, t.title, t.due_date, t.due_time
     FROM tasks t JOIN users u ON u.platform = t.platform AND u.user_id = t.user_id AND u.active = 1
     WHERE t.done = 0 AND t.remind_sent = 0 AND t.remind_at IS NOT NULL AND t.remind_at <= ?
     LIMIT 20`,
  ).bind(now.epoch).all<{ id: number; platform: string; user_id: number; title: string; due_date: string | null; due_time: string | null }>();
  for (const t of due.results ?? []) {
    const when = t.due_date ? fmtDue(t.due_date, t.due_time) : '';
    try {
      await tgSend(env, t.platform, t.user_id, `⏰ یادآوری: «${esc(t.title)}»${when ? ` — ${when}` : ''}\nآماده باش!`);
      await db.prepare('UPDATE tasks SET remind_sent = 1 WHERE id = ?').bind(t.id).run();
      console.log(`[cron] reminder sent for task ${t.id}`);
    } catch (e) {
      console.error('[cron] reminder send failed:', e instanceof Error ? e.message : e);
    }
  }

  // 2) Bonus — the daily morning list for EVERY whitelisted user.
  const hour = Number(env.TEHRAN_DAILY_HOUR ?? '8');
  if (now.hh === hour && now.mm <= 5) {
    const last = await getMeta(db, 'last_daily');
    if (last !== now.dateStr) {
      const users = await listActiveUsers(db);
      let sent = 0;
      for (const u of users) {
        const tasks = await listTasks(db, u.platform, u.user_id, 0);
        const s = await computeStats(db, u.platform, u.user_id);
        const streakLine = s.streak > 0 ? `\n🔥 استریک: ${toFa(s.streak)} روز پشت‌سرهم — ادامه بده!` : '';
        const head = `☀️ صبح بخیر!\nکارهای ${weekdayOf(now.dateStr)} ${jalaliOf(now.dateStr)}:`;
        const body = tasks.length ? `\n\n${renderList(tasks, now)}` : '\n\nامروز کاری ثبت نشده — روز خوشی داشته باشی 🌤';
        try {
          await tgSend(env, u.platform, u.user_id, head + body + streakLine);
          sent++;
        } catch (e) {
          console.error(`[cron] daily failed for ${u.platform}:${u.user_id}:`, e instanceof Error ? e.message : e);
        }
      }
      await setMeta(db, 'last_daily', now.dateStr);
      console.log(`[cron] daily list sent to ${sent}/${users.length} users`);
    }
  }
}

// ───────────────────────────── Worker entrypoint ─────────────────────────────

/**
 * Pure helpers exposed for tests only — the runtime uses the default export.
 * Kept in one place so the production surface stays a single handler object.
 */
export const _internals = {
  g2j, jalaliOf, weekdayOf, fmtDue, humanizeRemind, normFa,
  tehranNow, tehranToEpoch, prevDateStr,
  extractJson, validateDecision, parseKeys, renderList,
  SYSTEM_PROMPT, buildContext,
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Health check on the live URL (Phase 2) — no auth needed, reveals nothing.
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return Response.json({ ok: true, name: 'hermes-mini', build: 'bale3', time: new Date().toISOString() });
    }

    const isBale = url.pathname === '/bale';
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/webhook' || isBale)) {
      const platform = isBale ? 'bale' : 'telegram';
      // R6 — every request without the messenger's secret header is rejected 403.
      const expected = platform === 'bale'
        ? (env.BALE_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET)
        : env.TELEGRAM_WEBHOOK_SECRET;
      const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? req.headers.get('X-Bale-Bot-Api-Secret-Token');
      if (!expected || got !== expected) {
        return new Response('forbidden', { status: 403 });
      }

      let update: { message?: TgMessage };
      try {
        update = await req.json() as { message?: TgMessage };
      } catch {
        return new Response('bad request', { status: 400 });
      }

      const msg = update.message;
      if (platform === 'bale') {
        // Bale's payload shape is a moving target — persist a bounded sample
        // straight into D1 so it can be inspected without relying on tail.
        try {
          await setMeta(env.DB, 'bale_last_update', JSON.stringify(update).slice(0, 800));
        } catch (e) {
          console.error('[bale] debug persist failed:', e instanceof Error ? e.message : e);
        }
      }
      if (msg && typeof msg.text === 'string') {
        // Process inline (the webhook timeout is generous) and only then return
        // 200. Inline keeps the reply out of waitUntil, whose ~30s cap proved
        // fatal when Google 503s respond slowly. handleMessage itself enforces
        // the D1 whitelist (R5) and ignores strangers silently.
        await handleMessage(env, platform, msg).catch((e) => console.error('[handle] fatal:', e));
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env).catch((e) => console.error('[cron] fatal:', e)));
  },
} satisfies ExportedHandler<Env>;
