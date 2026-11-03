/**
 * Live model benchmark — measures latency AND decision quality of candidate
 * Gemini models against the REAL production prompt + validator.
 *
 * Run:  node --experimental-strip-types --no-warnings tests/bench-models.mts
 * (Reads the real key from .dev.vars; calls the Gemini REST API directly.)
 */
import { readFileSync } from 'node:fs';
import { _internals as X } from '../src/worker.ts';

// ── load a real key from .dev.vars (git-ignored) ─────────────────────────────
const dev = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const line = dev.split(/\r?\n/).find((l) => l.startsWith('GEMINI_KEYS'))!;
const keys: string[] = JSON.parse(line.slice('GEMINI_KEYS='.length));
const KEY = keys[0];

// ── production-faithful fixture ──────────────────────────────────────────────
// Today (per system) = Tue 2026-11-03 → Persian week: شنبه 11-07 … جمعه 11-13
const NOW = { y: 2026, m: 11, d: 3, hh: 20, mm: 0, dateStr: '2026-11-03', epoch: Date.UTC(2026, 10, 3, 16, 30) };
const mkTask = (id: number, title: string, due_date: string | null, due_time: string | null) => ({
  id, user_id: 1, title, due_date, due_time,
  due_ts: due_date ? 1 : null, remind_at: null, remind_sent: 0, done: 0, created_at: 1, done_at: null,
});
const TASKS = [
  mkTask(2, 'خرید بلیط قطار مشهد', '2026-11-06', null),
  mkTask(3, 'جلسه پروژه با استاد', '2026-11-04', '14:00'),
  mkTask(5, 'جلسه تمرین گروهی', '2026-11-05', '18:30'),
  mkTask(7, 'تمرین ریاضی ۲', null, null),
];
const HISTORY = [
  { r: 'u' as const, t: 'سلام' },
  { r: 'b' as const, t: 'سلام! چه خبر؟' },
];

const CASES = [
  { name: 'add+rel.date', msg: 'میان‌ترم درس رایانش ابری دوشنبه هفته دیگه ساعت ۱۰ دارم',
    judge: (v: any) => v.action === 'add' && v.date === '2026-11-09' && v.time === '10:00' },
  { name: 'done by id', msg: 'جلسه‌ی پروژه رو انجام دادم',
    judge: (v: any) => v.action === 'done' && Array.isArray(v.target_ids) && v.target_ids.includes(3) },
  { name: 'delete all', msg: 'همه‌ی کارهام رو پاک کن',
    judge: (v: any) => v.action === 'del' && v.all === true },
  { name: 'chat', msg: 'سلام! فردا هوا چطوره؟',
    judge: (v: any) => v.action === 'chat' },
  { name: 'ambiguous→clarify', msg: 'جلسه رو حذف کن', // TWO جلسه tasks — should clarify, not guess
    judge: (v: any) => v.action === 'chat' || (v.action === 'del' && !v.all && (v.target_ids?.length ?? 0) === 0) },
];

const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

async function call(model: string, msg: string): Promise<{ ok: boolean; ms: number; raw?: string; err?: string }> {
  const contents = [{ role: 'user', parts: [{ text: `${X.buildContext(NOW, TASKS, HISTORY)}\n\n### پیام جدید کاربر\n${msg}` }] }];
  const t0 = performance.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: X.SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 4096 },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, ms, err: `HTTP ${res.status}` };
    const j: any = await res.json();
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
    if (!text) return { ok: false, ms, err: 'empty' };
    return { ok: true, ms, raw: text };
  } catch (e: any) {
    return { ok: false, ms: Math.round(performance.now() - t0), err: e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e).slice(0, 60) };
  }
}

for (const model of MODELS) {
  const row: string[] = [];
  let okCount = 0, passCount = 0, msSum = 0;
  for (const c of CASES) {
    const r = await call(model, c.msg);
    if (!r.ok) { row.push(`${c.name}:✗(${r.err},${r.ms}ms)`); continue; }
    okCount++; msSum += r.ms;
    let v: any;
    try { v = X.validateDecision(r.raw!, NOW); } catch { v = { error: 'crash' }; }
    if ('error' in v) { row.push(`${c.name}:INVALID-json`); continue; }
    const pass = c.judge(v);
    if (pass) passCount++;
    row.push(`${c.name}:${pass ? '✓' : '≈'}(${v.action}${v.date ? ',' + v.date : ''}${v.all ? ',all' : ''}${v.target_ids?.length ? ',ids=' + v.target_ids : ''} · ${r.ms}ms)`);
  }
  const avg = okCount ? Math.round(msSum / okCount) : 0;
  console.log(`\n== ${model} — success ${okCount}/5, quality ${passCount}/${okCount || '–'} ok-calls, avg ${avg}ms`);
  console.log('   ' + row.join('\n   '));
}
console.log('\n(✓ = matches expected decision, ≈ = plausible but different, ✗/INVALID = failed)');
