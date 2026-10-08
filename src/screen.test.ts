import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, screenBusiness } from './screen.ts';
import type { Audit, Business } from './types.ts';

const biz = (over: Partial<Business> = {}): Business => ({
  id: 'places:x', source: 'places', externalId: 'x', name: 'Lakeside Chiropractic', category: 'chiropractor',
  town: 'Alexandria', state: 'MN', address: null, phone: '3205550101', website: 'https://lakeside.example',
  rating: 4.8, reviewCount: 12, hoursSet: true, hours: null, photoCount: 3, mapsUrl: null, status: 'OPERATIONAL', brand: null,
  email: null, firstSeen: 'a', lastSeen: 'a', ...over,
});
const audit = (over: Partial<Audit> = {}): Audit => ({
  businessId: 'places:x', auditedAt: 'a', finalUrl: 'https://lakeside.example/', siteStatus: 'ok', psiMobile: 40, cms: null, siteText: null,
  facts: [], contacts: [{ email: 'info@lakeside.example', sourceUrl: 'u', kind: 'generic', confidence: 'high' }], ...over,
});
const none = (_v: string) => false;
const run = (b: Business, a: Audit | null = audit(), shares = 1, suppressed = none) =>
  screenBusiness({ business: b, audit: a, domainShares: shares, suppressed });

test('a local independent with a weak site passes', () => {
  const s = run(biz());
  assert.equal(s.verdict, 'pass');
  assert.deepEqual(s.reasons, []);
  assert.deepEqual(s.flags, []);
});

test('outside MN/WI', () => assert.deepEqual(run(biz({ state: 'VA' })).reasons, ['outside-area']));
test('closed', () => assert.deepEqual(run(biz({ status: 'CLOSED_PERMANENTLY' })).reasons, ['not-operating']));
test('chain by name', () => assert.deepEqual(run(biz({ name: 'Anytime Fitness Alexandria' })).reasons, ['chain']));
test('chain by OSM brand', () => assert.deepEqual(run(biz({ brand: 'Great Clips' })).reasons, ['chain']));
test('chain by a domain many locations share', () => assert.deepEqual(run(biz(), audit(), 5).reasons, ['chain']));
test('"Regis" in a word is not the chain', () => assert.equal(run(biz({ name: 'Registered Massage of Osakis' })).verdict, 'pass'));
test('CrossFit affiliates are not chains', () => assert.equal(run(biz({ name: 'CrossFit Alexandria' })).verdict, 'pass'));
test('the client, by name or domain, from its own rules', () => {
  const rules = { ...DEFAULT_RULES, clients: /\b(omnia|omniatherapies\.com)\b/i };
  assert.deepEqual(screenBusiness({ business: biz({ name: 'Omnia Wellness' }), audit: audit(), domainShares: 1, suppressed: () => false }, rules).reasons, ['client']);
  assert.deepEqual(screenBusiness({ business: biz({ website: 'https://omniatherapies.com' }), audit: audit({ finalUrl: 'https://omniatherapies.com/' }),
    domainShares: 1, suppressed: () => false }, rules).reasons, ['client']);
});
test('suppressed domain or every email suppressed', () => {
  assert.deepEqual(run(biz(), audit(), 1, (v) => v === 'lakeside.example').reasons, ['suppressed']);
  assert.deepEqual(run(biz(), audit(), 1, (v) => v === 'info@lakeside.example').reasons, ['suppressed']);
});
test('no email is a flag, not a rule-out', () => {
  const s = run(biz({ website: null }), audit({ siteStatus: 'none', finalUrl: null, contacts: [] }));
  assert.equal(s.verdict, 'pass');
  assert.deepEqual(s.flags, ['no-email']);
});
