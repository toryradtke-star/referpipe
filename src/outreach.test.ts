import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, dailyCap, emailProblems, pickRecipient, readUnsubToken, senderProblems, unsubToken, type Sender } from './outreach.ts';
import { Store } from './db.ts';

const mock = 'https://preview.webcraftmn.com/p/sunrise-chiropractic-menomonie/';
const source = 'Sunrise Chiropractic\nGoogle PageSpeed mobile performance score is 31/100\n20-minute';
const good = `Your site is easy to read, but Google's speed test scores it 31 out of 100 on a phone.\n\nI put together a concept of a faster version:\n${mock}\n\nWorth a 20-minute call?`;

test('a grounded, short email with only the mock link passes', () => {
  assert.deepEqual(emailProblems(good, { source, link: mock, maxWords: 130, subject: 'a concept for sunrise' }), []);
});

test('invented numbers, extra links, missing mock, greetings and spam words are caught', () => {
  const p = (body: string, subject?: string) => emailProblems(body, { source, link: mock, maxWords: 130, subject });
  assert.ok(p(good.replace('31', '42')).includes('number "42" is not in the audit or the site'));
  assert.ok(p(`${good}\nhttps://calendly.com/tory`).some((x) => x.startsWith('link https://calendly.com/tory')));
  assert.ok(p(good.replace(mock, '')).includes('the link is missing'));
  assert.ok(p(`Hi Sam,\n${good}`).includes('starts with a greeting (the code adds it)'));
  assert.ok(p(`${good}\n\nBest,\nTory`).includes('ends with a sign-off (the code adds it)'));
  assert.ok(p(`${good} Risk-free.`).some((x) => x.startsWith('spam-filter wording')));
  assert.ok(p(good, 'Re: your website!').includes('subject has "!" or a fake Re:/Fwd:'));
});

test('unsubscribe tokens round-trip and reject tampering', () => {
  const t = unsubToken('s3cret', 'DrSam@Sunrise.example');
  assert.equal(readUnsubToken('s3cret', t), 'drsam@sunrise.example');
  assert.equal(readUnsubToken('other', t), null);
  const [, sig] = t.split('.');
  assert.equal(readUnsubToken('s3cret', `${Buffer.from('someone@else.com').toString('base64url')}.${sig}`), null);
});

test('warmup cap: 5, then 12, then 25', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  assert.equal(dailyCap(null, now), 5);
  assert.equal(dailyCap('2026-10-17', now), 5);
  assert.equal(dailyCap('2026-10-10', now), 12);
  assert.equal(dailyCap('2026-10-01', now), 25);
});

test('recipient: a person at high confidence first; suppressed never', () => {
  const c = (email: string, kind: 'person' | 'generic', confidence: 'high' | 'medium') => ({ email, kind, confidence, sourceUrl: '' });
  const list = [c('info@x.com', 'generic', 'high'), c('jo@gmail.com', 'person', 'medium'), c('linda@x.com', 'person', 'high')];
  assert.equal(pickRecipient(list, () => false)?.email, 'linda@x.com');
  assert.equal(pickRecipient(list, (v) => v === 'linda@x.com')?.email, 'info@x.com');
  assert.equal(pickRecipient([], () => false), null);
});

const sender: Sender = { fromName: 'Tory Radtke', fromEmail: 'tory@webcraft-outreach.example', replyTo: 'tory@webcraft-outreach.example',
  company: 'Webcraft', website: 'https://webcraftmn.com', phone: '3205550123', postalAddress: 'PO Box 1, Alexandria, MN 56308',
  unsubBase: 'https://preview.webcraftmn.com/u/', warmupStart: null };

test('a confident owner name replaces "there"', () => {
  assert.match(compose('Body.', sender, 'u', 'Sam'), /^Hi Sam,\n/);
});

test('the fixed parts: greeting, signature, postal address, unsubscribe', () => {
  const t = compose('Body.', sender, 'https://preview.webcraftmn.com/u/abc');
  assert.match(t, /^Hi there,\n\nBody\.\n\nTory\nWebcraft · \(320\) 555-0123\n\n/);
  assert.match(t, /PO Box 1, Alexandria, MN 56308\. If you'd rather not hear from me, reply "stop" or use https:\/\/preview\.webcraftmn\.com\/u\/abc$/);
});

test('sender: complete, and never from webcraftmn.com', () => {
  assert.deepEqual(senderProblems(sender), []);
  assert.ok(senderProblems({ ...sender, fromEmail: 'tory@webcraftmn.com' }).some((p) => p.includes('outreach subdomain')));
  assert.deepEqual(senderProblems({ ...sender, fromEmail: 'tory@hello.webcraftmn.com' }), []);
  assert.ok(senderProblems({ ...sender, postalAddress: '' }).includes('sender.postalAddress is empty'));
  assert.deepEqual(senderProblems(null), ['profile/sender.json is missing']);
});

// The gate, end to end through the CLI, against a throwaway store.
test('send refuses without --confirm send, without a sender, and with a stale sync', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referpipe-gate-'));
  const env = { ...process.env, REFERPIPE_HOME: dir, REFERPIPE_SHARED_SECRETS: join(dir, 'none.env'), LEADPIPE_DB: join(dir, 'none.db'),
    RESEND_API_KEY: 'x', UNSUB_SECRET: 'y' };
  const bin = new URL('../bin/referpipe.ts', import.meta.url).pathname;
  const run = (...a: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...a], { env, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (e: any) { return { code: e.status as number, out: `${e.stdout}${e.stderr}` }; }
  };
  let r = run('send');
  assert.equal(r.code, 1); assert.match(r.out, /needs `--confirm send`/);
  r = run('send', '--confirm', 'yes');
  assert.equal(r.code, 1);
  r = run('send', '--confirm', 'send');
  assert.equal(r.code, 1); assert.match(r.out, /sender\.json is missing/);
  // A complete sender, one message already sent, and no sync on record.
  mkdirSync(join(dir, 'profile'), { recursive: true });
  writeFileSync(join(dir, 'profile', 'sender.json'), JSON.stringify(sender));
  const s = new Store(join(dir, 'data', 'referpipe.db'));
  s.db.exec(`INSERT INTO businesses (id, source, external_id, name, category, town, state, first_seen, last_seen) VALUES ('osm:1','osm','1','A','gym','T','MN','x','x')`);
  s.db.exec(`INSERT INTO messages (business_id, step, to_email, subject, body, status, sent_at) VALUES ('osm:1', 1, 'a@b.com', 's', 'b', 'sent', '2026-10-01')`);
  s.close();
  r = run('send', '--confirm', 'send');
  assert.equal(r.code, 1); assert.match(r.out, /sync` has not run in the last 24 hours/);
});
