/**
 * Quick logic tests for the pure parts of src/worker.ts.
 * Run with:  node --experimental-strip-types tests/quick-test.mts
 * (No network, no secrets — everything here is deterministic.)
 */
import assert from 'node:assert/strict';
import { _internals as X } from '../src/worker.ts';

let passed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// ── Jalali conversion ────────────────────────────────────────────────────────
console.log('Jalali dates');
t('2026-11-03 → 12 آبان 1405', () => {
  assert.deepEqual(X.g2j(2026, 11, 3), { jy: 1405, jm: 8, jd: 12 });
});
t('Nowruz 1404 = 2025-03-21', () => {
  assert.deepEqual(X.g2j(2025, 3, 21), { jy: 1404, jm: 1, jd: 1 });
});
t('Nowruz 1403 = 2024-03-20', () => {
  assert.deepEqual(X.g2j(2024, 3, 20), { jy: 1403, jm: 1, jd: 1 });
});
t('1403 is a leap year: 2025-03-20 = 30 اسفند 1403', () => {
  assert.deepEqual(X.g2j(2025, 3, 20), { jy: 1403, jm: 12, jd: 30 });
});
t('Nowruz 1405 = 2026-03-21', () => {
  assert.deepEqual(X.g2j(2026, 3, 21), { jy: 1405, jm: 1, jd: 1 });
});
t('jalaliOf renders Persian digits + month name', () => {
  assert.equal(X.jalaliOf('2026-11-03'), '۱۲ آبان ۱۴۰۵');
});

// ── Tehran time ──────────────────────────────────────────────────────────────
console.log('Tehran time');
t('tehranToEpoch = Date.UTC - 210min', () => {
  assert.equal(
    X.tehranToEpoch(2026, 11, 3, 9, 30),
    Date.UTC(2026, 10, 3, 9, 30) - 210 * 60000,
  );
});
t('tehranNow dateStr shape', () => {
  assert.match(X.tehranNow().dateStr, /^\d{4}-\d{2}-\d{2}$/);
});

// ── Humanized reminders ──────────────────────────────────────────────────────
console.log('humanizeRemind');
t('1440 → یک روز قبل', () => assert.equal(X.humanizeRemind(1440), 'یک روز قبل'));
t('2880 → ۲ روز قبل', () => assert.equal(X.humanizeRemind(2880), '۲ روز قبل'));
t('30 → نیم ساعت قبل', () => assert.equal(X.humanizeRemind(30), 'نیم ساعت قبل'));
t('90 → ۱.۵ ساعت قبل', () => assert.equal(X.humanizeRemind(90), '۱.۵ ساعت قبل'));
t('45 → ۴۵ دقیقه قبل', () => assert.equal(X.humanizeRemind(45), '۴۵ دقیقه قبل'));

// ── Text normalization ───────────────────────────────────────────────────────
console.log('normFa');
t('Arabic vs Persian ي/ک match', () => {
  assert.equal(X.normFa('شير'), X.normFa('شیر'));
  assert.equal(X.normFa('جلسهى كتاب'), X.normFa('جلسه‌ی کتاب'));
});
t('Persian digits fold to Latin', () => {
  assert.equal(X.normFa('جلسه ۲'), X.normFa('جلسه 2'));
});

// ── Gemini keys parsing ──────────────────────────────────────────────────────
console.log('parseKeys');
t('JSON array', () => assert.deepEqual(X.parseKeys('["a","b"]'), ['a', 'b']));
t('comma/space separated', () => assert.deepEqual(X.parseKeys('a, b\nc  d'), ['a', 'b', 'c', 'd']));
t('single key', () => assert.deepEqual(X.parseKeys(' solo '), ['solo']));
t('empty → []', () => assert.deepEqual(X.parseKeys(''), []));
t('undefined → []', () => assert.deepEqual(X.parseKeys(undefined), []));

// ── JSON extraction ──────────────────────────────────────────────────────────
console.log('extractJson');
t('strips ```json fences', () => {
  assert.equal(X.extractJson('```json\n{"a":1}\n```'), '{"a":1}');
});
t('strips surrounding prose', () => {
  assert.equal(X.extractJson('sure!\n{"a":1}\nthanks'), '{"a":1}');
});

// ── Decision validation (R3 robustness) ──────────────────────────────────────
console.log('validateDecision');
const NOW = { y: 2026, m: 11, d: 3, hh: 12, mm: 0, dateStr: '2026-11-03', epoch: Date.UTC(2026, 10, 3, 8, 30) };

t('valid add with date/time/remind', () => {
  const v = X.validateDecision(
    '{"action":"add","task":"میان‌ترم رایانش ابری","date":"2026-11-09","time":"10:00","remind_minutes":2880,"reply":"ثبت شد"}',
    NOW,
  );
  assert.equal('error' in v, false);
  if (!('error' in v)) {
    assert.equal(v.action, 'add');
    assert.equal(v.date, '2026-11-09');
    assert.equal(v.time, '10:00');
    assert.equal(v.remind_minutes, 2880);
  }
});
t('Persian-digit date is normalized', () => {
  const v = X.validateDecision('{"action":"add","task":"x","date":"۲۰۲۶-۱۱-۰۹","reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.date, '2026-11-09');
});
t('add with time but no date → today', () => {
  const v = X.validateDecision('{"action":"add","task":"x","time":"5:00","reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.date, '2026-11-03') || assert.equal(v.time, '05:00');
});
t('add without title → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"add","reply":"r"}', NOW), true);
});
t('bad action → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"fly","reply":"r"}', NOW), true);
});
t('date two days in the past → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"add","task":"x","date":"2026-11-01","reply":"r"}', NOW), true);
});
t('yesterday tolerated (LLM off-by-one)', () => {
  const v = X.validateDecision('{"action":"add","task":"x","date":"2026-11-02","reply":"r"}', NOW);
  assert.equal('error' in v, false);
});
t('done without any target → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"done","reply":"r"}', NOW), true);
});
t('done with target_ids ok', () => {
  const v = X.validateDecision('{"action":"done","target_ids":[3],"reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.deepEqual(v.target_ids, [3]);
});
t('del all=true ok', () => {
  const v = X.validateDecision('{"action":"del","all":true,"reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.all, true);
});
t('malformed JSON → error (no crash)', () => {
  assert.equal('error' in X.validateDecision('not json at all', NOW), true);
});
t('non-JSON prose → error', () => {
  assert.equal('error' in X.validateDecision('{"action": add}', NOW), true);
});
t('crazy remind_minutes is capped at 30 days', () => {
  const v = X.validateDecision('{"action":"add","task":"x","date":"2026-12-01","remind_minutes":999999999,"reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.remind_minutes, 43200);
});
t('negative/zero remind → null', () => {
  const v = X.validateDecision('{"action":"add","task":"x","date":"2026-12-01","remind_minutes":-5,"reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.remind_minutes, null);
});

// ── Multi-user era: edit / search / stats / category / scope ─────────────────
console.log('validateDecision (new actions)');
t('edit with reminder change is valid', () => {
  const v = X.validateDecision('{"action":"edit","target_query":"جلسه","remind_minutes":120,"reply":"ok"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) {
    assert.equal(v.remind_minutes, 120);
    assert.equal(v.target_query, 'جلسه');
  }
});
t('edit without target → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"edit","remind_minutes":120,"reply":"r"}', NOW), true);
});
t('edit without any change → error', () => {
  assert.equal('error' in X.validateDecision('{"action":"edit","target_ids":[3],"reply":"r"}', NOW), true);
});
t('add with category is kept', () => {
  const v = X.validateDecision('{"action":"add","task":"درس ریاضی","category":"درس","reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.category, 'درس');
});
t('del with scope=done is kept', () => {
  const v = X.validateDecision('{"action":"del","all":true,"scope":"done","reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.scope, 'done');
});
t('search action is accepted', () => {
  const v = X.validateDecision('{"action":"search","target_query":"آزمون","reply":"r"}', NOW);
  assert.equal('error' in v, false);
  if (!('error' in v)) assert.equal(v.action, 'search');
});
t('stats action is accepted', () => {
  const v = X.validateDecision('{"action":"stats","reply":"r"}', NOW);
  assert.equal('error' in v, false);
});
t('prevDateStr walks correctly across month end', () => {
  // 2026-11-01 → previous day is 2026-10-31
  const prev = X.prevDateStr ? X.prevDateStr('2026-11-01') : null;
  assert.equal(prev, '2026-10-31');
});

// ── List rendering ───────────────────────────────────────────────────────────
console.log('renderList');
t('groups by today/later, shows ids and hint', () => {
  const tasks = [
    { id: 3, user_id: 1, title: 'میان‌ترم رایانش ابری', due_date: '2026-11-03', due_time: '10:00', due_ts: 1, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null },
    { id: 5, user_id: 1, title: 'خرید شیر', due_date: null, due_time: null, due_ts: null, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null },
    { id: 7, user_id: 1, title: 'جلسه پروژه', due_date: '2026-11-05', due_time: null, due_ts: 2, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null },
  ];
  const s = X.renderList(tasks, NOW);
  assert.ok(s.includes('امروز'), 'today header');
  assert.ok(s.includes('3. میان‌ترم رایانش ابری'), 'task line with id');
  assert.ok(s.includes('بدون تاریخ'), 'dateless group');
  assert.ok(s.includes('پنجشنبه'), 'weekday header for +2 days (Thu 2026-11-05)');
  assert.ok(s.includes('💡'), 'hint');
});
t('overdue group comes first', () => {
  const tasks = [
    { id: 9, user_id: 1, title: 'عقب‌افتاده', due_date: '2026-10-30', due_time: null, due_ts: 1, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null },
    { id: 4, user_id: 1, title: 'امروزی', due_date: '2026-11-03', due_time: null, due_ts: 2, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null },
  ];
  const s = X.renderList(tasks, NOW);
  assert.ok(s.indexOf('عقب‌افتاده ⚠️') < s.indexOf('امروز'), 'overdue before today');
});

console.log(`\nAll ${passed} tests passed ✅`);
