#!/usr/bin/env node
/**
 * Registers the webhook for Telegram (api.telegram.org) and/or Bale (tapi.bale.ai).
 *
 * Usage:
 *   node scripts/set-webhook.mjs <worker-url> [token] [secret] [--bale]
 *
 * --bale          register on Bale instead of Telegram (BALE_BOT_TOKEN needed)
 * token/secret default to env TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET
 * (or BALE_BOT_TOKEN with --bale), or to your local .dev.vars.
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const isBale = args.includes('--bale');
const positional = args.filter((a) => !a.startsWith('--'));
const [url, tokenArg, secretArg] = positional;

function loadDevVars() {
  const p = new URL('../.dev.vars', import.meta.url);
  if (!existsSync(p)) return {};
  try {
    const s = readFileSync(p, 'utf8');
    return Object.fromEntries(
      s.split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

const dv = loadDevVars();
const token = tokenArg
  || (isBale ? (process.env.BALE_BOT_TOKEN || dv.BALE_BOT_TOKEN) : (process.env.TELEGRAM_BOT_TOKEN || dv.TELEGRAM_BOT_TOKEN));
const secret = secretArg
  || (isBale ? (process.env.BALE_WEBHOOK_SECRET || dv.BALE_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || dv.TELEGRAM_WEBHOOK_SECRET)
             : (process.env.TELEGRAM_WEBHOOK_SECRET || dv.TELEGRAM_WEBHOOK_SECRET));
const base = isBale ? 'https://tapi.bale.ai' : 'https://api.telegram.org';
const platform = isBale ? 'bale' : 'telegram';
const hookUrl = isBale ? `${url}/bale` : url;

if (!url || !token || !secret) {
  console.error('usage: node scripts/set-webhook.mjs <worker-url> [token] [secret] [--bale]');
  console.error('       (token/secret also read from env or .dev.vars)');
  process.exit(1);
}

const res = await fetch(`${base}/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: hookUrl, secret_token: secret, allowed_updates: ['message'] }),
});
const j = await res.json();
console.log(`[${platform}] ${hookUrl}`);
console.log(JSON.stringify(j, null, 2));
if (!j.ok) process.exit(1);
