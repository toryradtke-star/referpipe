// Regressions for the 2026-10-08 correctness review: each test pins one bug that was found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.ts';
import { foreignDomain, pickRecipient } from './outreach.ts';
import type { Business } from './types.ts';

const biz = (id: string, over: Partial<Business> = {}): Business => ({
  id, source: 'places', externalId: id, name: 'Acme Dental', category: 'dentist', town: 'Duluth', state: 'MN', address: null,
  phone: null, website: null, rating: null, reviewCount: null, hoursSet: null, hours: null, photoCount: null, mapsUrl: null,
  status: 'OPERATIONAL', brand: null, email: null, firstSeen: '2026-10-01', lastSeen: '2026-10-01', ...over,
});
const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), 'lp-')), 'lp.db'));

test('send refuses a valueless --test-to, an unknown flag, and a non-address', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-send-'));
  const env = { ...process.env, REFERPIPE_HOME: dir, REFERPIPE_SHARED_SECRETS: join(dir, 'none.env'), RESEND_API_KEY: 'x', UNSUB_SECRET: 'y' };
  const run = (...a: string[]) => {
    try { execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../bin/referpipe.ts', import.meta.url).pathname, 'send', ...a], { env, stdio: 'pipe' }); return { code: 0, out: '' }; }
    catch (e: any) { return { code: e.status as number, out: `${e.stdout}${e.stderr}` }; }
  };
  let r = run('--confirm', 'send', '--test-to');
  assert.equal(r.code, 1); assert.match(r.out, /--test-to was given without a value/);
  r = run('--confirm', 'send', '--testto=me@x.com');
  assert.equal(r.code, 1); assert.match(r.out, /unknown flag --testto/);
  r = run('--confirm', 'send', '--test-to=notanemail');
  assert.equal(r.code, 1); assert.match(r.out, /is not an email address/);
  r = run('--confirm', 'send', '--id=');
  assert.equal(r.code, 1); assert.match(r.out, /--id was given without a value/);
});

test('stale (purged) businesses never dedupe into each other, and are re-screened when seen again', () => {
  const s = fresh();
  s.upsertBusinesses([biz('places:a'), biz('places:b', { name: 'Other Dental' })]);
  for (const id of ['places:a', 'places:b']) s.putScreen({ businessId: id, verdict: 'pass', reasons: [], flags: [], screenedAt: 'x' });
  s.db.exec(`UPDATE businesses SET stale = 1, name = '(stale)'`);
  assert.equal(s.passing().length, 0);
  s.upsertBusinesses([biz('places:a')]);
  assert.equal(s.query(`SELECT COUNT(*) n FROM screens WHERE business_id = 'places:a'`)[0].n, 0, 'screen cleared for a fresh look');
  assert.equal(s.query(`SELECT stale FROM businesses WHERE id = 'places:a'`)[0].stale, 0);
});

test('follow-up timing compares instants, not strings (ISO "T" vs SQLite space)', () => {
  const s = fresh();
  const sentAt = new Date(Date.now() - 4 * 86_400_000 - 60_000).toISOString(); // 4 days and a minute ago
  const r = s.query(`SELECT julianday(?) <= julianday('now', '-4 days') due, ? <= datetime('now', '-4 days') old_way`, sentAt, sentAt)[0];
  assert.equal(r.due, 1);
});

test('recipients: their own domain first; another business domain is flagged, free mail is not', () => {
  const c = (email: string) => ({ email, sourceUrl: '', kind: 'person' as const, confidence: 'high' as const });
  assert.equal(pickRecipient([c('web@designstudio.example'), c('info@comfortchiro.example')], () => false, 'comfortchiro.example')?.email, 'info@comfortchiro.example');
  assert.equal(foreignDomain('web@designstudio.example', 'comfortchiro.example'), true);
  assert.equal(foreignDomain('drsam@gmail.com', 'sunrise.example'), false);
  assert.equal(foreignDomain('office@mail.harborsmiles.example', 'harborsmiles.example'), false);
});
