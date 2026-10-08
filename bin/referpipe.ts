#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * referpipe — introduce a client (a clinic, a gym) to the local businesses
 * that could send it patients or members, behind the same send gate as
 * leadpipe (~/leadpipe, Webcraft's own prospecting), whose skeleton it shares.
 *
 * Each command does one thing, for one client (clients/<name>/):
 *   init        create a client's starter files
 *   poll        search the next slice of the category x town grid
 *   enrich      read each new business's site, collect published emails
 *   screen      apply the deterministic rule-outs, then dedupe the survivors
 *   judge       Claude rates the referral fit, quoting the partner's own site
 *   draft       write the introduction and two follow-ups for each hot/warm lead
 *   queue       move what may go out today into the queue (warmup cap)
 *   outbox      the queued emails as cards to read before sending
 *   edit, skip  change a draft, or stop a business's sequence
 *   send        THE GATE: sends the queue only with --confirm send
 *   sync        bounces/complaints/unsubscribes from Resend
 *   replied     record a reply; ends that business's sequence
 *   report      write the lead list as markdown
 *   stats       what the store holds right now
 *   suppress    never contact an email or domain
 *   export-csv  passing leads as CSV
 *
 * Only `send --confirm send` sends anything.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.ts';
import { toCsv } from '../src/csv.ts';
import * as places from '../src/sources/places.ts';
import * as osm from '../src/sources/osm.ts';
import { auditBusiness } from '../src/enrich.ts';
import { DEFAULT_RULES, screenBusiness, type Rules } from '../src/screen.ts';
import { groups, preferred } from '../src/dedupe.ts';
import { domainOf, formatPhone } from '../src/normalize.ts';
import type { Category, Targets, Town } from '../src/types.ts';
import { judgeReferral, referralProblems, writeReferralDrafts, type Hook } from '../src/referral.ts';
import { findOwner, greetingName } from '../src/owners.ts';
import { compose, dailyCap, pickRecipient, resendStatus, sendViaResend, senderProblems, sourceFor,
  resendUnsubscribed, unsubToken, foreignDomain, type Sender } from '../src/outreach.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `--client <name>` (or REFERPIPE_CLIENT) picks clients/<name>/: its targets,
 * profile, database and outbox. With one client it is the default. Taken out
 * of argv before anything else reads it, so `send`'s strict flag check never
 * sees it.
 */
const argv = process.argv.slice(2);
let CLIENT = process.env.REFERPIPE_CLIENT || undefined;
{
  const i = argv.findIndex((a) => a === '--client' || a.startsWith('--client='));
  if (i >= 0) {
    const eq = argv[i].startsWith('--client=');
    CLIENT = eq ? argv[i].slice('--client='.length) : argv[i + 1];
    argv.splice(i, eq ? 1 : 2);
  }
  const known = existsSync(join(ROOT, 'clients')) ? readdirSync(join(ROOT, 'clients')).filter((d) => existsSync(join(ROOT, 'clients', d, 'targets.json'))) : [];
  if (CLIENT === undefined && known.length === 1) CLIENT = known[0];
  const creating = argv[0] === 'init' && CLIENT !== undefined && /^[a-z0-9][a-z0-9-]*$/.test(CLIENT);
  // REFERPIPE_HOME points at a client folder directly (tests, or a client kept elsewhere).
  if (process.env.REFERPIPE_HOME) CLIENT ??= basename(process.env.REFERPIPE_HOME);
  else if (argv[0] && !creating && (!CLIENT || !known.includes(CLIENT))) {
    console.error(CLIENT ? `no client "${CLIENT}" (clients/: ${known.join(', ') || 'none'})` : `which client? --client ${known.join(' | ') || '<name> (then `init`)'}`);
    process.exit(1);
  }
}
const HOME = process.env.REFERPIPE_HOME ?? join(ROOT, 'clients', CLIENT ?? '_');
const DB_PATH = join(HOME, 'data', 'referpipe.db');
const PROFILE_DIR = join(HOME, 'profile');
const TARGETS = join(HOME, 'targets.json');
const OUT = join(HOME, 'out');
/** leadpipe's store, read only to warn when Webcraft's outreach already wrote to the same business. */
const LEADPIPE_DB = process.env.LEADPIPE_DB ?? join(homedir(), 'leadpipe', 'data', 'leadpipe.db');

const args = argv.slice(1);
/** `--name value` or `--name=value`; undefined when absent or given without a value. */
function flag(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3) || undefined;
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
const has = (name: string) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
/** Today's date where Tory is (the daily cap counts Minnesota days, not UTC ones). */
const localDate = () => new Date().toLocaleDateString('en-CA');
const num = (name: string, fallback: number) => { const v = Number(flag(name)); return Number.isFinite(v) && v > 0 ? v : fallback; };

/**
 * Secrets from the environment, else the client's profile/secrets.env, else the shared file
 * (REFERPIPE_SHARED_SECRETS, default leadpipe's): one Google key and one Resend account serve every client.
 */
const secrets = (() => {
  const read = (path: string) => {
    const own: Record<string, string> = {};
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && m[2]) own[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    return own;
  };
  const own = read(join(PROFILE_DIR, 'secrets.env'));
  const main = read(process.env.REFERPIPE_SHARED_SECRETS ?? join(homedir(), 'leadpipe', 'profile', 'secrets.env'));
  return (key: string) => process.env[key] || own[key] || main[key] || undefined;
})();
const googleKey = () => secrets('GOOGLE_API_KEY');

function targets(): Targets {
  const t = JSON.parse(readFileSync(TARGETS, 'utf8')) as Targets;
  const cats = flag('category')?.split(',');
  const towns = flag('town')?.split(',').map((s) => s.trim().toLowerCase());
  return {
    categories: t.categories.filter((c) => !cats || cats.includes(c.key)),
    towns: t.towns.filter((w) => !towns || towns.includes(w.name.toLowerCase())),
  };
}

/** Rules with the client's additions from profile/rules.json: extra chains, and the client's own names. */
function rules(): Rules {
  const path = join(PROFILE_DIR, 'rules.json');
  if (!existsSync(path)) return DEFAULT_RULES;
  const own = JSON.parse(readFileSync(path, 'utf8')) as { chains?: string[]; clients?: string[]; states?: string[] };
  const extend = (re: RegExp, more?: string[]) => more?.length ? new RegExp(`${re.source}|\\b(${more.join('|')})\\b`, 'i') : re;
  return { ...DEFAULT_RULES, states: own.states ?? DEFAULT_RULES.states,
    chains: extend(DEFAULT_RULES.chains, own.chains), clients: extend(DEFAULT_RULES.clients, own.clients) };
}

const store = () => new Store(DB_PATH);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
  }));
}

// ------------------------------------------------------------------ poll

async function cmdPoll() {
  const s = store();
  const purged = s.purgeStalePlaces();
  if (purged) console.log(`purged Places content from ${purged} businesses not refreshed in 30 days`);
  const t = targets();
  const sources = (flag('source') ?? (googleKey() ? 'places,osm' : 'osm')).split(',');
  if (sources.includes('places') && !googleKey()) {
    console.error('places needs GOOGLE_API_KEY (env or profile/secrets.env); polling osm only');
    sources.splice(sources.indexOf('places'), 1);
  }
  const slice = num('slice', 10);
  const times = s.searchTimes();
  const pollId = s.startPoll();
  const tally = { ok: 0, failed: 0, requests: 0, seen: 0, added: 0, errors: [] as string[] };
  const now = new Date().toISOString();
  const oldestFirst = <T>(list: T[], key: (x: T) => string) =>
    list.map((x) => ({ x, t: times.get(key(x)) ?? '' })).sort((a, b) => a.t.localeCompare(b.t)).map((r) => r.x).slice(0, slice);

  if (sources.includes('places')) {
    const grid: [Category, Town][] = t.categories.flatMap((c) => t.towns.map((w) => [c, w] as [Category, Town]));
    const todo = oldestFirst(grid, ([c, w]) => `places|${c.key}|${w.name}|${w.state}`);
    console.log(`places: ${todo.length} of ${grid.length} searches (least recently run first)`);
    await pool(todo, 3, async ([c, w]) => {
      try {
        const { businesses, requests } = await places.search(c, w, { key: googleKey()!, now, pages: num('pages', 3) });
        const r = s.upsertBusinesses(businesses);
        s.recordSearch('places', c.key, w.name, w.state, businesses.length, requests);
        Object.assign(tally, { ok: tally.ok + 1, requests: tally.requests + requests, seen: tally.seen + r.seen, added: tally.added + r.added });
        console.log(`  ${c.key} in ${w.name}, ${w.state}: ${r.seen} found, ${r.added} new`);
      } catch (err) {
        tally.failed++;
        tally.errors.push(`places ${c.key} ${w.name}: ${err instanceof Error ? err.message : err}`);
        console.log(`  ${c.key} in ${w.name}, ${w.state}: FAILED ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      }
    });
  }

  if (sources.includes('osm')) {
    // One Overpass query per town covers every category; one at a time, as its usage policy asks.
    const todo = oldestFirst(t.towns, (w) => `osm|*|${w.name}|${w.state}`);
    console.log(`osm: ${todo.length} of ${t.towns.length} towns`);
    for (const w of todo) {
      try {
        const found = await osm.search(t.categories, w, { now });
        const r = s.upsertBusinesses(found);
        s.recordSearch('osm', '*', w.name, w.state, found.length, 1);
        Object.assign(tally, { ok: tally.ok + 1, seen: tally.seen + r.seen, added: tally.added + r.added });
        console.log(`  ${w.name}, ${w.state}: ${r.seen} found, ${r.added} new`);
      } catch (err) {
        tally.failed++;
        tally.errors.push(`osm ${w.name}: ${err instanceof Error ? err.message : err}`);
        console.log(`  ${w.name}, ${w.state}: FAILED ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      }
      await sleep(2000);
    }
  }
  s.finishPoll(pollId, tally);
  console.log(`\n${tally.ok} searches ok, ${tally.failed} failed; ${tally.seen} businesses seen, ${tally.added} new${tally.requests ? `; ${tally.requests} Places requests` : ''}`);
  s.close();
}

// ------------------------------------------------------------------ enrich

async function cmdEnrich() {
  const s = store();
  const todo = s.unaudited(num('limit', 50), { id: flag('id'), days: num('older-than', 90) });
  // A partner's PageSpeed score is beside the point; --psi still records it.
  const psi = has('psi');
  console.log(`reading ${todo.length} businesses' sites`);
  let n = 0;
  await pool(todo, num('concurrency', 4), async (b) => {
    const a = await auditBusiness(b, { psi, psiKey: googleKey() });
    s.putAudit(a);
    console.log(`  [${++n}/${todo.length}] ${b.name} (${b.town}): ${a.siteStatus}, ${a.contacts.length} email${a.contacts.length === 1 ? '' : 's'}`);
  });
  s.close();
}

// ------------------------------------------------------------------ screen

function cmdScreen() {
  const s = store();
  const r = rules();
  const shares = s.domainShares();
  const suppression = s.suppression();
  const suppressed = (v: string) => suppression.has(v.toLowerCase()) || suppression.has(v.split('@')[1]?.toLowerCase() ?? '');
  const todo = s.unscreened(has('all'));
  const tally: Record<string, number> = {};
  let pass = 0;
  for (const b of todo) {
    const audit = s.audit(b.id);
    const domain = domainOf(audit?.finalUrl ?? b.website);
    const sc = screenBusiness({ business: b, audit, domainShares: domain ? shares.get(domain) ?? 0 : 0, suppressed }, r);
    s.putScreen(sc);
    if (sc.verdict === 'pass') pass++;
    for (const reason of sc.reasons) tally[reason] = (tally[reason] ?? 0) + 1;
  }
  // Dedupe among survivors only.
  let dupes = 0;
  for (const g of groups(s.passing())) {
    const keep = preferred(g);
    for (const c of g) if (c.id !== keep.id) { s.markDuplicate(c.id, keep.id); dupes++; }
  }
  // Anything drafted for a business that no longer passes (client, suppressed, duplicate) stops here.
  let stoppedNow = 0;
  for (const r of s.query(`SELECT DISTINCT m.business_id FROM messages m JOIN screens sc ON sc.business_id = m.business_id
      WHERE sc.verdict = 'out' AND m.status IN ('draft', 'queued')`)) stoppedNow += s.stopLead(r.business_id, 'screened out');
  console.log(`screened ${todo.length}: ${pass} passed, ${todo.length - pass} out`);
  if (stoppedNow) console.log(`  stopped ${stoppedNow} unsent emails for businesses now ruled out`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  if (dupes) console.log(`  duplicate (after screen): ${dupes}`);
  s.close();
}

// ------------------------------------------------------------------ judge

async function cmdJudge() {
  const s = store();
  const read = (name: string) => { const p = join(PROFILE_DIR, name); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const profile = { offer: read('offer.md'), rubric: read('rubric.md') };
  if (!profile.offer.trim() || !profile.rubric.trim()) { console.error('profile/offer.md and profile/rubric.md are needed'); process.exit(1); }
  const todo = s.unjudged(num('limit', 20), flag('id'));
  console.log(`judging ${todo.length} leads${flag('model') ? ` with ${flag('model')}` : ''}`);
  let n = 0, failed = 0;
  await pool(todo, num('concurrency', 3), async (b) => {
    const a = s.audit(b.id);
    if (!a) return;
    const v = await judgeReferral(b, a, s.flags(b.id), profile, { model: flag('model') });
    n++;
    if ('error' in v) { failed++; console.log(`  [${n}/${todo.length}] ${b.name}: FAILED ${v.error}`); return; }
    s.putJudgment(v);
    console.log(`  [${n}/${todo.length}] ${b.name} (${b.town}, ${b.category}): ${v.tier} · fit ${v.need}${v.hooks.length ? ` · "${v.hooks[0].fact}"` : ''}`);
  });
  if (failed) console.log(`${failed} failed; they stay unjudged and the next run retries them`);
  s.close();
}

// ------------------------------------------------------------------ outreach

function sender(): Sender | null {
  const p = join(PROFILE_DIR, 'sender.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Sender : null;
}

const suppressedIn = (s: Store) => {
  const set = s.suppression();
  return (v: string) => set.has(v.toLowerCase()) || set.has(v.split('@')[1]?.toLowerCase() ?? '');
};

/** Any reply, bounce, complaint or unsubscribe ends a business's sequence. */
const STOP_EVENTS = ['reply', 'bounce', 'complaint', 'unsubscribe'];
/** Passed the screen as of now: a business ruled out after drafting (a client, a suppressed domain, a duplicate) gets nothing more. */
const stillALead = (s: Store, id: string) => s.query(`SELECT 1 FROM screens WHERE business_id = ? AND verdict = 'pass'`, id).length > 0;
const stopped = (s: Store, id: string) => s.query(`SELECT 1 FROM events WHERE business_id = ? AND kind IN (SELECT value FROM json_each(?)) LIMIT 1`,
  id, JSON.stringify(STOP_EVENTS)).length > 0;

async function cmdDraft() {
  const s = store();
  const me = sender();
  const offerPath = join(PROFILE_DIR, 'offer.md');
  const offer = existsSync(offerPath) ? readFileSync(offerPath, 'utf8') : '';
  // Drafting needs only the parts of the sender the email body uses.
  if (!me?.fromName || !me.company) { console.error('profile/sender.json needs fromName and company before drafting'); process.exit(1); }
  const writer = me;
  const isSuppressed = suppressedIn(s);
  // --redo rewrites sequences that have not started sending (after a prompt change).
  const todo = has('redo')
    ? s.rows(`SELECT b.* FROM businesses b WHERE b.id IN (SELECT business_id FROM messages WHERE step = 1 AND status IN ('draft', 'queued'))
        AND (? IS NULL OR b.id = ?) LIMIT ?`, flag('id') ?? null, flag('id') ?? null, num('limit', 50))
    : s.needsDraft(num('limit', 10), flag('id'));
  console.log(`drafting ${todo.length} sequences${has('redo') ? ' (rewriting unsent drafts)' : ''}`);
  let n = 0;
  await pool(todo, num('concurrency', 3), async (b) => {
    const a = s.audit(b.id)!;
    const j = s.judgment(b.id)!;
    const to = pickRecipient(a.contacts, isSuppressed, domainOf(a.finalUrl ?? b.website));
    const i = ++n;
    if (!to) { console.log(`  [${i}/${todo.length}] ${b.name}: no unsuppressed email`); return; }
    const d = await writeReferralDrafts(b, a, j, offer, writer, { model: flag('model') });
    if ('error' in d) { console.log(`  [${i}/${todo.length}] ${b.name}: FAILED ${d.error}`); return; }
    s.putDrafts(b.id, to.email, d);
    console.log(`  [${i}/${todo.length}] ${b.name} → ${to.email}: "${d.step1.subject}"`);
  });
  s.close();
}

/**
 * Moves what may go out today into the queue: follow-ups that have come due
 * first, then first emails by need, up to the warmup cap less what already
 * went out or is waiting today.
 */
function cmdQueue() {
  const s = store();
  const me = sender();
  const cap = num('cap', dailyCap(me?.warmupStart ?? null));
  const used = s.query(`SELECT COUNT(*) n FROM messages WHERE (status = 'sent' AND date(sent_at, 'localtime') = date('now', 'localtime')) OR status = 'queued'`)[0].n as number;
  let room = Math.max(0, cap - used);
  const now = new Date().toISOString();
  const queue = s.db.prepare(`UPDATE messages SET status = 'queued', queued_at = ? WHERE id = ?`);
  let followups = 0, firsts = 0;
  // Step 2 four days after step 1; step 3 six days after step 2.
  const due = s.query(`SELECT m.id, m.business_id FROM messages m JOIN messages prev ON prev.business_id = m.business_id AND prev.step = m.step - 1
    WHERE m.status = 'draft' AND m.step > 1 AND prev.status = 'sent'
      AND julianday(prev.sent_at) <= julianday('now', CASE m.step WHEN 2 THEN '-4 days' ELSE '-6 days' END)
    ORDER BY prev.sent_at`);
  for (const m of due) {
    if (room <= 0) break;
    if (stopped(s, m.business_id)) { s.stopLead(m.business_id, 'stop event'); continue; }
    if (!stillALead(s, m.business_id)) { s.stopLead(m.business_id, 'screened out'); continue; }
    queue.run(now, m.id); room--; followups++;
  }
  const firstsDue = s.query(`SELECT m.id, m.business_id FROM messages m JOIN judgments j ON j.business_id = m.business_id
    JOIN screens sc ON sc.business_id = m.business_id AND sc.verdict = 'pass'
    JOIN businesses b ON b.id = m.business_id AND b.stale = 0
    WHERE m.status = 'draft' AND m.step = 1 ORDER BY j.need DESC`);
  for (const m of firstsDue) {
    if (room <= 0) break;
    if (stopped(s, m.business_id)) { s.stopLead(m.business_id, 'stop event'); continue; }
    queue.run(now, m.id); room--; firsts++;
  }
  console.log(`queued ${firsts} first emails and ${followups} follow-ups (cap ${cap}/day, ${used} already used today)`);
  s.close();
}

/** Emails and domains Webcraft's outreach (leadpipe) has already written to: the card warns before a second sender writes. */
function webcraftContacted(): (email: string) => string | null {
  if (!existsSync(LEADPIPE_DB)) return () => null;
  const m = new Store(LEADPIPE_DB);
  const rows = m.query(`SELECT DISTINCT to_email, status FROM messages WHERE status IN ('sent', 'queued', 'draft')`);
  m.close();
  return (email) => {
    const d = email.split('@')[1]?.toLowerCase();
    const hit = rows.find((r) => r.to_email.toLowerCase() === email.toLowerCase())
      ?? rows.find((r) => d && r.to_email.split('@')[1]?.toLowerCase() === d && !/@(gmail|yahoo|hotmail|outlook|aol|icloud)\./i.test(email));
    return hit ? `${hit.to_email} (${hit.status})` : null;
  };
}

function cmdOutbox() {
  const s = store();
  const alsoWebcraft = webcraftContacted();
  const rows = s.query(`SELECT m.*, b.name, b.town, b.state, b.category, b.website, j.need, j.tier, j.hooks, j.reasoning
    FROM messages m JOIN businesses b ON b.id = m.business_id LEFT JOIN judgments j ON j.business_id = b.id
    WHERE m.status = ? ORDER BY m.step DESC, j.need DESC`, has('drafts') ? 'draft' : 'queued');
  const steps = has('drafts') && !has('all-steps') ? rows.filter((r) => r.step === 1) : rows;
  if (!steps.length) console.log(has('drafts') ? 'No drafts.' : 'Queue is empty. Run `referpipe queue`.');
  for (const r of steps) {
    const hooks = JSON.parse(r.hooks ?? '[]') as Hook[];
    console.log(`#${r.id}  ${r.name} — ${r.category}, ${r.town} ${r.state}  [${r.tier} · fit ${r.need}]`);
    console.log(`     to ${r.to_email} · step ${r.step} · ${r.website ?? 'no website'}`);
    const overlap = alsoWebcraft(r.to_email);
    if (overlap) console.log(`     ⚠ Webcraft's outreach also has ${overlap}: decide whether both should write`);
    if (foreignDomain(r.to_email, domainOf(r.website))) console.log(`     ⚠ ${r.to_email} is on another business's domain, not ${domainOf(r.website)}: check it's theirs (could be their web designer)`);
    if (r.step === 1) {
      console.log(`     why: ${r.reasoning}`);
      for (const h of hooks) console.log(`     their site: "${h.fact}" → ${h.angle}`);
    }
    const contact = s.contacts(r.business_id).find((c) => c.email === r.to_email) ?? { email: r.to_email, kind: 'person' };
    const first = greetingName(s.owner(r.business_id), contact);
    console.log(`     greeting: Hi ${first ?? 'there'},${s.owner(r.business_id)?.name ? `  (LinkedIn: ${s.owner(r.business_id)!.name}, ${s.owner(r.business_id)!.confidence})` : ''}`);
    console.log(`     Subject: ${r.subject}\n${r.body.split('\n').map((l: string) => `     | ${l}`).join('\n')}\n`);
  }
  s.close();
}

/** `edit <id> --subject S` or `--body-file F`; a hand edit is not re-checked by the model, but is by the rules. */
function cmdEdit() {
  const id = Number(args.find((a) => /^\d+$/.test(a)));
  const s = store();
  const m = s.query(`SELECT * FROM messages WHERE id = ? AND status IN ('draft', 'queued')`, id)[0];
  if (!m) { console.error(`no draft or queued message #${id}`); process.exit(1); }
  const subject = flag('subject') ?? m.subject;
  const body = flag('body-file') ? readFileSync(flag('body-file')!, 'utf8').trim() : m.body;
  const b = s.business(m.business_id)!;
  const offerPath = join(PROFILE_DIR, 'offer.md');
  const offer = existsSync(offerPath) ? readFileSync(offerPath, 'utf8') : '';
  const problems = referralProblems(body, { source: sourceFor(b, s.audit(b.id)!, sender() ?? ({} as Sender), offer),
    link: null, maxWords: m.step === 1 ? 180 : 90, subject: m.step === 1 ? subject : undefined });
  if (problems.length && !has('force')) { console.error(`not saved:\n  ${problems.join('\n  ')}\n(--force saves anyway)`); process.exit(1); }
  s.db.prepare('UPDATE messages SET subject = ?, body = ? WHERE id = ?').run(subject, body, id);
  if (m.step === 1 && subject !== m.subject) s.db.prepare(`UPDATE messages SET subject = ? WHERE business_id = ? AND step > 1 AND status IN ('draft','queued')`).run(`Re: ${subject}`, m.business_id);
  console.log(`saved #${id}`);
  s.close();
}

/** `skip <id>`: this business gets nothing more. */
function cmdSkip() {
  const id = Number(args.find((a) => /^\d+$/.test(a)));
  const s = store();
  const m = s.query('SELECT business_id FROM messages WHERE id = ?', id)[0];
  if (!m) { console.error(`no message #${id}`); process.exit(1); }
  console.log(`stopped ${s.stopLead(m.business_id, flag('reason') ?? 'skipped by hand')} messages`);
  s.close();
}

/**
 * The gate. Nothing leaves without `--confirm send`, typed by Tory in the
 * session after reading the cards. Every guard is re-checked per message at
 * send time, because the queue may be a day old.
 */
async function cmdSend() {
  const s = store();
  const testTo = flag('test-to');
  const dry = has('dry-run');
  // A mistyped flag must never turn a test into a real send.
  const allowed = new Set(['confirm', 'test-to', 'dry-run', 'id', 'limit']);
  const unknown = args.filter((a) => a.startsWith('--') && !allowed.has(a.slice(2).split('=')[0]));
  if (unknown.length) { console.error(`Refusing: unknown flag ${unknown.join(', ')}`); process.exit(1); }
  for (const f of ['test-to', 'id', 'limit']) {
    if (has(f) && !flag(f)) { console.error(`Refusing: --${f} was given without a value`); process.exit(1); }
  }
  if (testTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo)) { console.error(`Refusing: --test-to "${testTo}" is not an email address`); process.exit(1); }
  if (!dry && flag('confirm') !== 'send') {
    console.error('Refusing: sending needs `--confirm send` (Tory types "send" after reading `referpipe outbox`). --dry-run shows what would go.');
    process.exit(1);
  }
  const me = sender();
  const resendKey = secrets('RESEND_API_KEY');
  const unsubSecret = secrets('UNSUB_SECRET') ?? (testTo || dry ? 'test-secret' : undefined);
  if (!testTo && !dry) {
    const problems = senderProblems(me);
    if (!unsubSecret) problems.push('UNSUB_SECRET is not set (profile/secrets.env)');
    if (!resendKey && !dry) problems.push('RESEND_API_KEY is not set (profile/secrets.env)');
    const ever = s.query(`SELECT COUNT(*) n FROM messages WHERE status = 'sent'`)[0].n as number;
    const lastSync = s.getMeta('last_sync');
    if (ever && (!lastSync || Date.now() - Date.parse(lastSync) > 86_400_000)) problems.push('`referpipe sync` has not run in the last 24 hours (bounces, unsubscribes, replies)');
    if (problems.length) { console.error(`Refusing:\n  ${problems.join('\n  ')}`); process.exit(1); }
  } else if (testTo && !resendKey && !dry) { console.error('Refusing: RESEND_API_KEY is not set'); process.exit(1); }

  // A test or dry run before the outreach domain is verified still shows the real text, from Resend's test sender.
  const from = { fromName: me?.fromName || 'referpipe', fromEmail: me?.fromEmail || 'onboarding@resend.dev', replyTo: me?.replyTo || testTo || '',
    listUnsubscribeHeader: me?.listUnsubscribeHeader ?? false };
  const full = { ...(me ?? {}), fromName: from.fromName, company: me?.company || '', website: me?.website || '',
    phone: me?.phone || '', postalAddress: me?.postalAddress || '[postal address goes here]', unsubBase: me?.unsubBase || 'https://preview.webcraftmn.com/u/' } as Sender;
  const isSuppressed = suppressedIn(s);
  const cap = dailyCap(me?.warmupStart ?? null);
  const today = localDate();
  let room = testTo || dry ? Infinity : cap - (s.query(`SELECT COUNT(*) n FROM messages WHERE status = 'sent' AND date(sent_at, 'localtime') = date('now', 'localtime')`)[0].n as number);
  const rows = s.query(`SELECT m.* FROM messages m
    WHERE m.status = 'queued' AND (? IS NULL OR m.id = ?) ORDER BY m.step DESC, m.id LIMIT ?`, flag('id') ?? null, flag('id') ?? null, num('limit', 100));
  let sent = 0, held = 0;
  for (const m of rows) {
    const hold = (why: string) => { held++; console.log(`  #${m.id} held: ${why}`); };
    if (stopped(s, m.business_id)) { s.stopLead(m.business_id, 'stop event'); hold('reply/bounce/unsubscribe on record; sequence stopped'); continue; }
    if (isSuppressed(m.to_email)) { s.stopLead(m.business_id, 'suppressed'); hold('suppressed'); continue; }
    if (!stillALead(s, m.business_id)) { s.stopLead(m.business_id, 'screened out'); hold('no longer passes the screen; sequence stopped'); continue; }
    if (room <= 0) { hold(`daily cap ${cap} reached`); continue; }
    // No trailing slash: the token has a dot, so Vercel treats the path as a file and would redirect a one-click POST.
    const unsubUrl = `${full.unsubBase}${unsubToken(unsubSecret!, m.to_email)}`;
    const contact = s.contacts(m.business_id).find((c) => c.email === m.to_email) ?? { email: m.to_email, kind: 'person' };
    const text = compose(m.body, full, unsubUrl, greetingName(s.owner(m.business_id), contact));
    const to = testTo ?? m.to_email;
    const subject = testTo ? `[TEST → ${m.to_email}] ${m.subject}` : m.subject;
    if (dry) { console.log(`--- #${m.id} to ${to}\nSubject: ${subject}\n\n${text}\n`); continue; }
    let providerId: string;
    try {
      providerId = await sendViaResend(resendKey!, from, { key: testTo ? `${CLIENT}-test-${m.id}-${Date.now()}` : `${CLIENT}-${m.id}`, to, subject, text, unsubUrl });
    } catch (err) {
      // Not retried automatically: a timeout may still have sent it.
      s.db.prepare(`UPDATE messages SET status = 'failed', note = ? WHERE id = ?`).run(err instanceof Error ? err.message.slice(0, 300) : String(err), m.id);
      console.log(`  #${m.id} FAILED (marked failed, not retried): ${err instanceof Error ? err.message : err}`);
      continue;
    }
    sent++; room--;
    if (testTo) { console.log(`  #${m.id} test copy sent to ${testTo} (${providerId})`); continue; }
    try {
      s.db.prepare(`UPDATE messages SET status = 'sent', sent_at = ?, provider_id = ? WHERE id = ?`).run(new Date().toISOString(), providerId, m.id);
      console.log(`  #${m.id} sent to ${m.to_email} (${providerId})`);
    } catch (err) {
      // Delivered but not recorded: stop here, or the next run would send it again.
      console.error(`  #${m.id} WAS SENT (${providerId}) but could not be recorded: ${err instanceof Error ? err.message : err}`);
      console.error(`  Stopping. Record it by hand: UPDATE messages SET status='sent', sent_at=datetime('now'), provider_id='${providerId}' WHERE id=${m.id};`);
      process.exitCode = 2;
      break;
    }
  }
  if (sent && !testTo && me && !me.warmupStart) {
    me.warmupStart = today;
    writeFileSync(join(PROFILE_DIR, 'sender.json'), JSON.stringify(me, null, 2) + '\n');
    console.log(`warmup starts today (${today}): cap 5/day this week, 12 next week, 25 after`);
  }
  if (!dry) console.log(`${sent} sent${testTo ? ' (test copies)' : ''}, ${held} held`);
  s.close();
}

/** Bounces, complaints and one-click unsubscribes, all from Resend. Replies are recorded with `replied`. */
async function cmdSync() {
  const s = store();
  const key = secrets('RESEND_API_KEY');
  const isFinal = (e: string) => ['bounced', 'complained', 'suppressed'].includes(e);
  let bounces = 0, complaints = 0, unsubs = 0, failures = 0;
  if (key) {
    const rows = s.query(`SELECT id, business_id, to_email, provider_id FROM messages WHERE status = 'sent' AND provider_id IS NOT NULL
      AND julianday(sent_at) > julianday('now', '-30 days')`);
    for (const r of rows) {
      const ev = await resendStatus(key, r.provider_id).catch(() => { failures++; return null; });
      if (!ev || !isFinal(ev)) continue;
      const kind = ev === 'complained' ? 'complaint' : 'bounce';
      if (s.query('SELECT 1 FROM events WHERE business_id = ? AND kind = ? AND email = ?', r.business_id, kind, r.to_email).length) continue;
      s.addEvent(r.business_id, r.to_email, kind, `message #${r.id}`);
      s.suppress(r.to_email, kind);
      s.stopLead(r.business_id, kind);
      kind === 'bounce' ? bounces++ : complaints++;
    }
  } else console.log('RESEND_API_KEY not set: bounces and complaints not checked');
  if (key) {
    const known = s.suppression();
    const unsubscribedList = await resendUnsubscribed(key).catch((err) => { failures++; console.log(`unsubscribe check failed: ${err instanceof Error ? err.message : err}`); return [] as string[]; });
    for (const email of unsubscribedList) {
      if (known.has(email)) continue;
      s.suppress(email, 'unsubscribe');
      for (const id of s.businessesFor(email)) { s.addEvent(id, email, 'unsubscribe'); s.stopLead(id, 'unsubscribed'); }
      unsubs++;
    }
  }
  // A sync that could not check everything does not count: send refuses until a clean one.
  if (key && !failures) s.setMeta('last_sync', new Date().toISOString());
  if (failures) console.log(`${failures} checks FAILED; last_sync not updated, so send will refuse until a clean sync`);
  if (!key) console.log('last_sync not updated without RESEND_API_KEY');
  const awaiting = s.query(`SELECT COUNT(DISTINCT business_id) n FROM messages WHERE status = 'sent'`)[0].n;
  console.log(`sync: ${bounces} bounces, ${complaints} complaints, ${unsubs} unsubscribes. ${awaiting} businesses have been emailed;`
    + ' check the reply inbox and record each reply with `referpipe replied <email> [--stop]`.');
  s.close();
}

/**
 * `owners`: LinkedIn lookups for the leads about to be emailed. Opt-in, a few
 * at a time, one after another: it browses LinkedIn as Tory, read-only.
 */
async function cmdOwners() {
  const s = store();
  const cfgPath = join(homedir(), '.claude.json');
  const server = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers ?? {}).linkedin : null;
  if (!server) { console.error('no `linkedin` MCP server in ~/.claude.json'); process.exit(1); }
  const todo = s.needsOwner(num('limit', 5), flag('id'));
  console.log(`looking up ${todo.length} owners on LinkedIn (read-only)`);
  for (const [i, b] of todo.entries()) {
    const o = await findOwner(b, server, { model: flag('model') });
    if ('error' in o) { console.log(`  [${i + 1}/${todo.length}] ${b.name}: FAILED ${o.error}`); continue; }
    // No name is not an answer worth keeping (a login wall reads the same as no match); try again next time.
    if (!o.name) { console.log(`  [${i + 1}/${todo.length}] ${b.name}: nothing found — ${o.evidence.slice(0, 140)}`); continue; }
    s.putOwner(b.id, o);
    console.log(`  [${i + 1}/${todo.length}] ${b.name}: ${o.name || '(none)'} · ${o.confidence}${o.title ? ` · ${o.title}` : ''}`);
  }
  s.close();
}

/** Who has been emailed and not yet replied, plus the Gmail search that finds their replies. */
function cmdSent() {
  const s = store();
  const rows = s.query(`SELECT b.name, m.to_email, MAX(m.sent_at) last_sent, MAX(m.step) step FROM messages m JOIN businesses b ON b.id = m.business_id
    WHERE m.status = 'sent' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.business_id = m.business_id AND e.kind IN ('reply', 'bounce', 'unsubscribe', 'complaint'))
    GROUP BY m.business_id ORDER BY last_sent DESC`);
  if (!rows.length) { console.log('Nobody is waiting on a reply.'); s.close(); return; }
  for (const r of rows) console.log(`${r.to_email.padEnd(38)} ${r.name} (step ${r.step}, last ${r.last_sent.slice(0, 10)})`);
  console.log(`\nGmail: in:inbox newer_than:45d from:(${rows.map((r) => r.to_email).join(' OR ')})`);
  s.close();
}

/** A reply ends the sequence. `--stop` (they asked not to be contacted) also suppresses the address. */
function cmdReplied() {
  const who = args.find((a) => !a.startsWith('--') && a !== flag('note'));
  if (!who) { console.error('usage: referpipe replied <email|business-id> [--stop] [--note TEXT]'); process.exit(1); }
  const s = store();
  const ids = who.includes('@') ? s.businessesFor(who) : [who];
  if (!ids.length) { console.error(`no business matches ${who}`); process.exit(1); }
  for (const id of ids) {
    s.addEvent(id, who.includes('@') ? who : null, 'reply', flag('note') ?? '');
    s.stopLead(id, has('stop') ? 'asked to stop' : 'replied');
    console.log(`recorded reply for ${s.business(id)?.name ?? id}; remaining follow-ups stopped`);
  }
  if (has('stop') && who.includes('@')) { s.suppress(who, 'asked to stop'); console.log(`suppressed ${who}`); }
  s.close();
}

// ------------------------------------------------------------------ report

const TIER_ORDER: Record<string, number> = { hot: 0, warm: 1, cold: 2, skip: 5 };

type Lead = Record<string, any> & { emails: string[]; flags: string[]; hooks: Hook[] };

function leads(s: Store): Lead[] {
  return s.query(`SELECT b.*, a.site_status, a.final_url, s.flags, j.tier, j.need, j.hooks, j.reasoning, j.skip_reason,
      (SELECT group_concat(email, ' ') FROM contacts c WHERE c.business_id = b.id) emails
    FROM businesses b JOIN screens s ON s.business_id = b.id AND s.verdict = 'pass'
    JOIN audits a ON a.business_id = b.id
    LEFT JOIN judgments j ON j.business_id = b.id`)
    .map((r): Lead => ({ ...r, flags: JSON.parse(r.flags), hooks: JSON.parse(r.hooks ?? '[]'), emails: r.emails ? r.emails.split(' ') : [] }))
    .sort((a, b) => (TIER_ORDER[a.tier] ?? 4) - (TIER_ORDER[b.tier] ?? 4) || (b.need ?? 0) - (a.need ?? 0)
      || Number(b.emails.length > 0) - Number(a.emails.length > 0) || a.name.localeCompare(b.name));
}

function cmdReport() {
  const s = store();
  const list = leads(s);
  const out = flag('out') ?? join(OUT, `partners-${new Date().toISOString().slice(0, 10)}.md`);
  const reasons = s.query(`SELECT reasons FROM screens WHERE verdict = 'out'`).flatMap((r) => JSON.parse(r.reasons) as string[])
    .map((x) => x.startsWith('duplicate:') ? 'duplicate' : x)
    .reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});
  const withEmail = list.filter((l) => l.emails.length).length;
  const lines = [
    `# Referral partners (${CLIENT}) — ${new Date().toISOString().slice(0, 10)}`, '',
    `${list.length} businesses passed the screen; ${withEmail} have a published email.`,
    `Ruled out: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '',
  ];
  for (const l of list) {
    lines.push(`## ${l.tier ? `[${l.tier}] ` : ''}${l.name} — ${l.category}, ${l.town} ${l.state}`);
    if (l.tier) lines.push(`- fit ${l.need}: ${l.tier === 'skip' ? `skip (${l.skip_reason})` : l.reasoning}`);
    for (const h of l.hooks) lines.push(`  - their site: "${h.fact}" → ${h.angle}`);
    lines.push(`- ${[formatPhone(l.phone), l.final_url ?? l.website ?? 'no website'].filter(Boolean).join(' · ')}`);
    lines.push(`- Email: ${l.emails.length ? l.emails.join(', ') : '_none published_'}${l.flags.length ? ` · flags: ${l.flags.join(', ')}` : ''}`);
    lines.push('');
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
  console.log(`${list.length} partners (${withEmail} with email) → ${out}`);
  s.close();
}

function cmdExportCsv() {
  const s = store();
  const out = flag('out') ?? join(OUT, 'partners.csv');
  const header = ['tier', 'need', 'name', 'category', 'town', 'state', 'phone', 'website', 'emails', 'why', 'quotes', 'flags', 'maps_url'];
  const rows = leads(s).map((l): Record<string, string | null> => ({ ...l, phone: formatPhone(l.phone), website: l.final_url ?? l.website,
    emails: l.emails.join(' '), why: l.reasoning ?? '', quotes: l.hooks.map((h) => h.fact).join(' | '), flags: l.flags.join(' '),
    need: l.need === null || l.need === undefined ? '' : String(l.need) }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(header, rows));
  console.log(`${rows.length} partners → ${out}`);
  s.close();
}

function cmdStats() {
  const s = store();
  const one = (sql: string) => Object.values(s.query(sql)[0] ?? { n: 0 })[0];
  console.log(`businesses   ${one('SELECT COUNT(*) FROM businesses')} (${one('SELECT COUNT(*) FROM businesses WHERE stale = 1')} stale)`);
  for (const r of s.query('SELECT source, COUNT(*) n FROM businesses GROUP BY source')) console.log(`  ${r.source.padEnd(10)} ${r.n}`);
  console.log(`audited      ${one('SELECT COUNT(*) FROM audits')}`);
  for (const r of s.query('SELECT site_status, COUNT(*) n FROM audits GROUP BY site_status ORDER BY n DESC')) console.log(`  ${r.site_status.padEnd(10)} ${r.n}`);
  console.log(`with email   ${one('SELECT COUNT(DISTINCT business_id) FROM contacts')}`);
  console.log(`screened     ${one('SELECT COUNT(*) FROM screens')} (${one(`SELECT COUNT(*) FROM screens WHERE verdict = 'pass'`)} pass)`);
  const grid = targets();
  console.log(`searches run ${one('SELECT COUNT(*) FROM searches')} (grid is ${grid.categories.length * grid.towns.length} Places + ${grid.towns.length} OSM)`);
  console.log(`Places requests, last 30 days: ${one(`SELECT COALESCE(SUM(places_requests), 0) FROM polls WHERE started_at > datetime('now', '-30 days')`)}`);
  console.log(`suppressed   ${one('SELECT COUNT(*) FROM suppression')}`);
  s.close();
}

function cmdSuppress() {
  const value = args.find((a) => !a.startsWith('--'));
  if (!value) { console.error('usage: referpipe suppress <email|domain> [--reason TEXT]'); process.exit(1); }
  const s = store();
  s.suppress(value, flag('reason') ?? 'manual');
  console.log(`suppressed ${value}; run \`referpipe screen --all\` to re-screen`);
  s.close();
}

function cmdInit() {
  const starters: Record<string, string> = {
    'targets.json': JSON.stringify({ categories: [{ key: 'chiropractor', label: 'Chiropractor', places: 'chiropractor', osm: ['healthcare=chiropractor'] }],
      towns: [{ name: 'Superior', state: 'WI' }] }, null, 2) + '\n',
    'profile/rules.json': JSON.stringify({ states: ['MN', 'WI'], chains: [], clients: ['<the client\'s own name>', '<its domain>'] }, null, 2) + '\n',
    'profile/sender.json': JSON.stringify({ fromName: '', fromEmail: '', replyTo: '', company: '', website: '', phone: '', postalAddress: '',
      unsubBase: 'https://preview.webcraftmn.com/u/', warmupStart: null, signature: [] }, null, 2) + '\n',
    'profile/offer.md': '# Who is writing and what they offer\n\nOnly facts from the client\'s own site. The judge and the writer read this.\n',
    'profile/rubric.md': '# How to judge a referral partner\n\nWho sends this client patients or members, who is a competitor, what to skip.\n',
  };
  for (const [name, body] of Object.entries(starters)) {
    const path = join(HOME, name);
    if (existsSync(path)) { console.log(`kept    ${path}`); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log(`created ${path}`);
  }
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  init: cmdInit, poll: cmdPoll, enrich: cmdEnrich, screen: cmdScreen, judge: cmdJudge, report: cmdReport,
  draft: cmdDraft, queue: cmdQueue, outbox: cmdOutbox, edit: cmdEdit, skip: cmdSkip, send: cmdSend, sync: cmdSync, replied: cmdReplied,
  owners: cmdOwners, sent: cmdSent, stats: cmdStats, suppress: cmdSuppress, 'export-csv': cmdExportCsv,
};

const command = argv[0];
if (!command || !COMMANDS[command]) {
  console.log(`referpipe — introduce a client to local businesses that could refer to it

  Every command takes --client NAME (clients/NAME/); with one client it is the default.

  referpipe init --client NAME                     starter files for a new client
  referpipe poll   [--source places,osm] [--slice 10] [--category gym] [--town Duluth] [--pages 3]
                                                   search the least recently run slice of the grid
  referpipe enrich [--limit 50] [--id ID] [--concurrency 4]
                                                   read their sites, collect published emails
  referpipe screen [--all]                         rule-outs (chains, health systems, the client), then dedupe
  referpipe judge  [--limit 20] [--id ID] [--model NAME] [--concurrency 3]
                                                   Claude rates the fit, quoting their site (no tools; scraped text is fenced)
  referpipe draft  [--limit 10] [--id ID] [--redo] introduction + 2 follow-ups per hot/warm partner
  referpipe queue  [--cap N]                       today's sends, within the warmup cap
  referpipe outbox [--drafts]                      read the queue as cards
  referpipe edit <msg> [--subject S] [--body-file F]   change a draft (rules re-checked)
  referpipe skip <msg> [--reason R]                stop that business's sequence
  referpipe send --confirm send [--test-to ADDR] [--dry-run] [--id MSG]
                                                   the gate: nothing leaves without --confirm send
  referpipe sync                                   bounces, complaints, unsubscribes (run within 24h of sending)
  referpipe replied <email|id> [--stop] [--note T] a reply stops the sequence; --stop also suppresses
  referpipe owners [--limit 5] [--id ID]           LinkedIn owner lookup (read-only) for the greeting
  referpipe sent                                   emailed and awaiting a reply, with the Gmail search for replies
  referpipe report [--out PATH]                    passing partners as markdown
  referpipe stats                                  what the store holds
  referpipe suppress <email|domain> [--reason R]   never contact this
  referpipe export-csv [--out PATH]                passing partners as CSV

Only send --confirm send sends. Secrets: env, clients/NAME/profile/secrets.env, then the shared file
(REFERPIPE_SHARED_SECRETS, default ~/leadpipe/profile/secrets.env): GOOGLE_API_KEY, RESEND_API_KEY, UNSUB_SECRET.`);
  process.exit(command ? 1 : 0);
}
await COMMANDS[command]();
