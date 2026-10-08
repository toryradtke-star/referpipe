/**
 * The store: one SQLite file through node:sqlite, as in jobpipe.
 *
 * Businesses are never deleted. A business no poll has refreshed in 30 days
 * has its Places-sourced fields purged (Google's terms allow caching them for
 * 30 days; the place id may be kept), and is marked stale until a poll sees it
 * again. What referpipe learned itself (the audit of the business's own site,
 * the screen, the judge) is kept.
 *
 * `migrate()` adds columns additively, never drops. Each client has its own file.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Audit, Business, Screen } from './types.ts';
import { domainOf } from './normalize.ts';
import type { Candidate } from './dedupe.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  town TEXT NOT NULL,
  state TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  website TEXT,
  domain TEXT,
  rating REAL,
  review_count INTEGER,
  hours_set INTEGER,
  photo_count INTEGER,
  maps_url TEXT,
  status TEXT,
  brand TEXT,
  email TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS businesses_domain ON businesses(domain);
CREATE INDEX IF NOT EXISTS businesses_town ON businesses(state, town);

CREATE TABLE IF NOT EXISTS audits (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  audited_at TEXT NOT NULL,
  final_url TEXT,
  site_status TEXT NOT NULL,
  psi_mobile INTEGER,
  cms TEXT,
  facts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  email TEXT NOT NULL,
  source_url TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (business_id, email)
);
CREATE INDEX IF NOT EXISTS contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS screens (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  verdict TEXT NOT NULL,
  reasons TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  screened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS screens_verdict ON screens(verdict);

CREATE TABLE IF NOT EXISTS judgments (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  need INTEGER,
  pitch TEXT,
  tier TEXT,
  hooks TEXT NOT NULL DEFAULT '[]',
  reasoning TEXT NOT NULL,
  skip_reason TEXT,
  judged_at TEXT NOT NULL,
  model TEXT NOT NULL
);

-- One row per category x town search per source; the poll works through the
-- least recently run first.
CREATE TABLE IF NOT EXISTS searches (
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  town TEXT NOT NULL,
  state TEXT NOT NULL,
  last_run TEXT NOT NULL,
  results INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, category, town, state)
);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  searches_ok INTEGER NOT NULL DEFAULT 0,
  searches_failed INTEGER NOT NULL DEFAULT 0,
  places_requests INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  step INTEGER NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TEXT,
  sent_at TEXT,
  provider_id TEXT,
  UNIQUE (business_id, step)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT REFERENCES businesses(id),
  email TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppression (
  value TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

-- Owner names from LinkedIn (leadpipe owners); used only for the greeting.
CREATE TABLE IF NOT EXISTS owners (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  name TEXT NOT NULL,
  title TEXT,
  url TEXT,
  confidence TEXT NOT NULL,
  evidence TEXT,
  looked_up_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // Wait for a busy writer (the timer and a session can overlap) instead of failing at once.
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after a store was first created. Additive only. */
  private migrate(): void {
    const cols = (t: string) => new Set((this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols('businesses').has('hours')) this.db.exec('ALTER TABLE businesses ADD COLUMN hours TEXT');
    if (!cols('audits').has('site_text')) this.db.exec('ALTER TABLE audits ADD COLUMN site_text TEXT');
    const msg = cols('messages');
    if (!msg.has('note')) this.db.exec('ALTER TABLE messages ADD COLUMN note TEXT');
    if (!msg.has('queued_at')) this.db.exec('ALTER TABLE messages ADD COLUMN queued_at TEXT');
  }

  /** Writes businesses, keeping the earliest first_seen. Returns how many were new. */
  upsertBusinesses(list: Business[]): { seen: number; added: number } {
    const insert = this.db.prepare(`
      INSERT INTO businesses (id, source, external_id, name, category, town, state, address, phone, website, domain,
        rating, review_count, hours_set, photo_count, maps_url, status, brand, email, stale, first_seen, last_seen, hours)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, town = excluded.town, state = excluded.state, address = excluded.address,
        phone = excluded.phone, website = excluded.website, domain = excluded.domain, rating = excluded.rating,
        review_count = excluded.review_count, hours_set = excluded.hours_set, photo_count = excluded.photo_count,
        maps_url = excluded.maps_url, status = excluded.status, brand = excluded.brand, email = excluded.email,
        hours = excluded.hours, stale = 0, last_seen = excluded.last_seen
    `);
    const exists = this.db.prepare('SELECT stale FROM businesses WHERE id = ?');
    const rescreen = this.db.prepare('DELETE FROM screens WHERE business_id = ?');
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const b of list) {
        const prior = exists.get(b.id) as { stale: number } | undefined;
        if (!prior) added++;
        // Purged while stale, possibly marked a duplicate of other stale rows: judge it afresh.
        else if (prior.stale) rescreen.run(b.id);
        insert.run(b.id, b.source, b.externalId, b.name, b.category, b.town, b.state, b.address, b.phone, b.website,
          domainOf(b.website), b.rating, b.reviewCount, b.hoursSet === null ? null : Number(b.hoursSet), b.photoCount,
          b.mapsUrl, b.status, b.brand, b.email, b.firstSeen, b.lastSeen, b.hours ? JSON.stringify(b.hours) : null);
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return { seen: list.length, added };
  }

  /**
   * Places content older than 30 days is dropped; the place id, the category
   * and town we searched, and leadpipe's own findings stay. The audit's
   * Places-sourced facts go too.
   */
  purgeStalePlaces(now = new Date()): number {
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const ids = (this.db.prepare(`SELECT id FROM businesses WHERE source = 'places' AND stale = 0 AND last_seen < ?`)
      .all(cutoff) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return 0;
    const clear = this.db.prepare(`UPDATE businesses SET name = '(stale)', address = NULL, phone = NULL, website = NULL,
      rating = NULL, review_count = NULL, hours_set = NULL, hours = NULL, photo_count = NULL, maps_url = NULL, status = NULL, stale = 1 WHERE id = ?`);
    const audit = this.db.prepare('SELECT facts FROM audits WHERE business_id = ?');
    const setFacts = this.db.prepare('UPDATE audits SET facts = ? WHERE business_id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        clear.run(id);
        const a = audit.get(id) as { facts: string } | undefined;
        if (a) setFacts.run(JSON.stringify(JSON.parse(a.facts).filter((f: any) => f.source !== 'places')), id);
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return ids.length;
  }

  recordSearch(source: string, category: string, town: string, state: string, results: number, requests: number): void {
    this.db.prepare(`INSERT INTO searches (source, category, town, state, last_run, results, requests) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source, category, town, state) DO UPDATE SET last_run = excluded.last_run, results = excluded.results,
      requests = searches.requests + excluded.requests`)
      .run(source, category, town, state, new Date().toISOString(), results, requests);
  }

  /** When each search last ran, keyed `${source}|${category}|${town}|${state}`. */
  searchTimes(): Map<string, string> {
    return new Map((this.db.prepare('SELECT source, category, town, state, last_run FROM searches').all() as Record<string, string>[])
      .map((r) => [`${r.source}|${r.category}|${r.town}|${r.state}`, r.last_run]));
  }

  putAudit(a: Audit): void {
    this.db.prepare(`INSERT INTO audits (business_id, audited_at, final_url, site_status, psi_mobile, cms, facts, site_text) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(business_id) DO UPDATE SET audited_at = excluded.audited_at, final_url = excluded.final_url,
      site_status = excluded.site_status, psi_mobile = excluded.psi_mobile, cms = excluded.cms, facts = excluded.facts,
      site_text = excluded.site_text`)
      .run(a.businessId, a.auditedAt, a.finalUrl, a.siteStatus, a.psiMobile, a.cms, JSON.stringify(a.facts), a.siteText);
    const put = this.db.prepare(`INSERT INTO contacts (business_id, email, source_url, kind, confidence, found_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(business_id, email) DO UPDATE SET source_url = excluded.source_url, kind = excluded.kind, confidence = excluded.confidence`);
    for (const c of a.contacts) put.run(a.businessId, c.email, c.sourceUrl, c.kind, c.confidence, a.auditedAt);
    // A business re-audited is re-screened.
    this.db.prepare('DELETE FROM screens WHERE business_id = ?').run(a.businessId);
  }

  audit(id: string): Audit | null {
    const r = this.db.prepare('SELECT * FROM audits WHERE business_id = ?').get(id) as Record<string, any> | undefined;
    if (!r) return null;
    return {
      businessId: id, auditedAt: r.audited_at, finalUrl: r.final_url, siteStatus: r.site_status, psiMobile: r.psi_mobile,
      cms: r.cms, siteText: r.site_text ?? null, facts: JSON.parse(r.facts), contacts: this.contacts(id),
    };
  }

  contacts(id: string): Audit['contacts'] {
    return (this.db.prepare('SELECT * FROM contacts WHERE business_id = ? ORDER BY confidence, kind DESC').all(id) as Record<string, string>[])
      .map((c) => ({ email: c.email, sourceUrl: c.source_url, kind: c.kind as 'person' | 'generic', confidence: c.confidence as 'high' | 'medium' }));
  }

  /** Businesses with no audit, or an audit older than `days`; never stale ones. */
  unaudited(limit: number, opts: { days?: number; id?: string } = {}): Business[] {
    const cutoff = new Date(Date.now() - (opts.days ?? 90) * 86_400_000).toISOString();
    return this.rows(`SELECT b.* FROM businesses b LEFT JOIN audits a ON a.business_id = b.id
      WHERE b.stale = 0 AND (a.business_id IS NULL OR a.audited_at < ?) AND (? IS NULL OR b.id = ?)
      ORDER BY b.first_seen LIMIT ?`, cutoff, opts.id ?? null, opts.id ?? null, limit);
  }

  /** Audited, not yet screened. `all` re-screens everything audited. */
  unscreened(all = false): Business[] {
    return this.rows(`SELECT b.* FROM businesses b JOIN audits a ON a.business_id = b.id
      LEFT JOIN screens s ON s.business_id = b.id WHERE b.stale = 0 AND (? OR s.business_id IS NULL)`, all ? 1 : 0);
  }

  putScreen(s: Screen): void {
    this.db.prepare(`INSERT INTO screens (business_id, verdict, reasons, flags, screened_at) VALUES (?,?,?,?,?)
      ON CONFLICT(business_id) DO UPDATE SET verdict = excluded.verdict, reasons = excluded.reasons,
      flags = excluded.flags, screened_at = excluded.screened_at`)
      .run(s.businessId, s.verdict, JSON.stringify(s.reasons), JSON.stringify(s.flags), s.screenedAt);
  }

  domainShares(): Map<string, number> {
    return new Map((this.db.prepare(`SELECT domain, COUNT(DISTINCT phone) n FROM businesses WHERE domain IS NOT NULL GROUP BY domain`)
      .all() as { domain: string; n: number }[]).map((r) => [r.domain, r.n]));
  }

  suppression(): Set<string> {
    return new Set((this.db.prepare('SELECT value FROM suppression').all() as { value: string }[]).map((r) => r.value.toLowerCase()));
  }

  suppress(value: string, reason: string): void {
    this.db.prepare('INSERT INTO suppression (value, reason, at) VALUES (?,?,?) ON CONFLICT(value) DO NOTHING')
      .run(value.toLowerCase(), reason, new Date().toISOString());
  }

  /** Every business that passed the screen, as dedupe candidates. */
  passing(): Candidate[] {
    return (this.db.prepare(`SELECT b.id, b.source, b.name, b.town, b.phone, b.website, b.first_seen,
        a.business_id IS NOT NULL enriched, j.business_id IS NOT NULL judged
      FROM businesses b JOIN screens s ON s.business_id = b.id AND s.verdict = 'pass'
      LEFT JOIN audits a ON a.business_id = b.id LEFT JOIN judgments j ON j.business_id = b.id
      WHERE b.stale = 0`).all() as Record<string, any>[])
      .map((r) => ({ id: r.id, source: r.source, name: r.name, town: r.town, phone: r.phone, website: r.website,
        firstSeen: r.first_seen, enriched: !!r.enriched, judged: !!r.judged }));
  }

  markDuplicate(id: string, of: string): void {
    this.db.prepare(`UPDATE screens SET verdict = 'out', reasons = ? WHERE business_id = ?`).run(JSON.stringify([`duplicate:${of}`]), id);
  }

  startPoll(): number {
    return Number(this.db.prepare('INSERT INTO polls (started_at) VALUES (?)').run(new Date().toISOString()).lastInsertRowid);
  }

  finishPoll(id: number, s: { ok: number; failed: number; requests: number; seen: number; added: number; errors: string[] }): void {
    this.db.prepare(`UPDATE polls SET finished_at = ?, searches_ok = ?, searches_failed = ?, places_requests = ?, seen = ?, added = ?, errors = ? WHERE id = ?`)
      .run(new Date().toISOString(), s.ok, s.failed, s.requests, s.seen, s.added, JSON.stringify(s.errors), id);
  }

  putJudgment(j: import('./referral.ts').Judgment): void {
    this.db.prepare(`INSERT INTO judgments (business_id, need, pitch, tier, hooks, reasoning, skip_reason, judged_at, model)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(business_id) DO UPDATE SET need = excluded.need, pitch = excluded.pitch,
      tier = excluded.tier, hooks = excluded.hooks, reasoning = excluded.reasoning, skip_reason = excluded.skip_reason,
      judged_at = excluded.judged_at, model = excluded.model`)
      .run(j.businessId, j.need, j.pitch, j.tier, JSON.stringify(j.hooks), j.reasoning, j.skipReason, j.judgedAt, j.model);
  }

  judgment(id: string): import('./referral.ts').Judgment | null {
    const r = this.db.prepare('SELECT * FROM judgments WHERE business_id = ?').get(id) as Record<string, any> | undefined;
    return r ? { businessId: id, need: r.need, pitch: r.pitch, tier: r.tier, hooks: JSON.parse(r.hooks), reasoning: r.reasoning,
      skipReason: r.skip_reason, judgedAt: r.judged_at, model: r.model } : null;
  }

  /** Passed the screen, audited, not judged. Leads with an email first. `id` narrows to one (judged or not). */
  unjudged(limit: number, id?: string): Business[] {
    return this.rows(`SELECT b.* FROM businesses b JOIN screens s ON s.business_id = b.id AND s.verdict = 'pass'
      JOIN audits a ON a.business_id = b.id LEFT JOIN judgments j ON j.business_id = b.id
      WHERE b.stale = 0 AND ((? IS NOT NULL AND b.id = ?) OR (? IS NULL AND j.business_id IS NULL))
      ORDER BY EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id) DESC, a.site_status = 'unknown', b.first_seen
      LIMIT ?`, id ?? null, id ?? null, id ?? null, limit);
  }

  flags(id: string): string[] {
    const r = this.db.prepare('SELECT flags FROM screens WHERE business_id = ?').get(id) as { flags: string } | undefined;
    return r ? JSON.parse(r.flags) : [];
  }

  /** Hot or warm, an email to write to, never drafted. */
  needsDraft(limit: number, id?: string): Business[] {
    return this.rows(`SELECT b.* FROM businesses b JOIN judgments j ON j.business_id = b.id
      JOIN screens s ON s.business_id = b.id AND s.verdict = 'pass'
      WHERE b.stale = 0 AND EXISTS (SELECT 1 FROM contacts c WHERE c.business_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.business_id = b.id)
        AND ((? IS NOT NULL AND b.id = ?) OR (? IS NULL AND j.tier IN ('hot', 'warm')))
      ORDER BY j.need DESC LIMIT ?`, id ?? null, id ?? null, id ?? null, limit);
  }

  putDrafts(businessId: string, to: string, d: import('./outreach.ts').Drafts): void {
    const ins = this.db.prepare(`INSERT INTO messages (business_id, step, to_email, subject, body, status) VALUES (?,?,?,?,?,'draft')
      ON CONFLICT(business_id, step) DO UPDATE SET to_email = excluded.to_email, subject = excluded.subject, body = excluded.body
      WHERE messages.status IN ('draft', 'queued')`);
    this.db.exec('BEGIN');
    try {
      ins.run(businessId, 1, to, d.step1.subject, d.step1.body);
      ins.run(businessId, 2, to, `Re: ${d.step1.subject}`, d.step2.body);
      ins.run(businessId, 3, to, `Re: ${d.step1.subject}`, d.step3.body);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** Stops every unsent step for a business. */
  stopLead(businessId: string, reason: string): number {
    return Number(this.db.prepare(`UPDATE messages SET status = 'stopped', note = ? WHERE business_id = ? AND status IN ('draft', 'queued')`)
      .run(reason, businessId).changes);
  }

  addEvent(businessId: string | null, email: string | null, kind: string, detail = ''): void {
    this.db.prepare('INSERT INTO events (business_id, email, kind, detail, at) VALUES (?,?,?,?,?)')
      .run(businessId, email, kind, detail, new Date().toISOString());
  }

  /** Businesses an email address belongs to, via messages or contacts. */
  businessesFor(email: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT business_id FROM messages WHERE lower(to_email) = lower(?)
      UNION SELECT DISTINCT business_id FROM contacts WHERE lower(email) = lower(?)`).all(email, email) as { business_id: string }[])
      .map((r) => r.business_id);
  }

  putOwner(id: string, o: import('./owners.ts').Owner): void {
    this.db.prepare(`INSERT INTO owners (business_id, name, title, url, confidence, evidence, looked_up_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(business_id) DO UPDATE SET name = excluded.name, title = excluded.title, url = excluded.url,
      confidence = excluded.confidence, evidence = excluded.evidence, looked_up_at = excluded.looked_up_at`)
      .run(id, o.name, o.title, o.url, o.confidence, o.evidence, new Date().toISOString());
  }

  owner(id: string): import('./owners.ts').Owner | null {
    const r = this.db.prepare('SELECT * FROM owners WHERE business_id = ?').get(id) as Record<string, any> | undefined;
    return r ? { name: r.name, title: r.title, url: r.url, confidence: r.confidence, evidence: r.evidence } : null;
  }

  /** Hot or warm leads with an unsent sequence and no lookup yet. */
  needsOwner(limit: number, id?: string): Business[] {
    return this.rows(`SELECT b.* FROM businesses b JOIN judgments j ON j.business_id = b.id
      WHERE ((? IS NOT NULL AND b.id = ?) OR (? IS NULL AND j.tier IN ('hot', 'warm')
        AND NOT EXISTS (SELECT 1 FROM owners o WHERE o.business_id = b.id)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.business_id = b.id AND m.step = 1 AND m.status IN ('draft', 'queued'))))
      ORDER BY j.need DESC LIMIT ?`, id ?? null, id ?? null, id ?? null, limit);
  }

  getMeta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  business(id: string): Business | null {
    return this.rows('SELECT * FROM businesses WHERE id = ?', id)[0] ?? null;
  }

  rows(sql: string, ...params: unknown[]): Business[] {
    return (this.db.prepare(sql).all(...(params as any[])) as Record<string, any>[]).map(fromRow);
  }

  query(sql: string, ...params: unknown[]): Record<string, any>[] {
    return this.db.prepare(sql).all(...(params as any[])) as Record<string, any>[];
  }

  close(): void { this.db.close(); }
}

function fromRow(r: Record<string, any>): Business {
  return {
    id: r.id, source: r.source, externalId: r.external_id, name: r.name, category: r.category, town: r.town, state: r.state,
    address: r.address, phone: r.phone, website: r.website, rating: r.rating, reviewCount: r.review_count,
    hoursSet: r.hours_set === null ? null : !!r.hours_set, hours: r.hours ? JSON.parse(r.hours) : null, photoCount: r.photo_count, mapsUrl: r.maps_url, status: r.status,
    brand: r.brand, email: r.email, firstSeen: r.first_seen, lastSeen: r.last_seen,
  };
}
