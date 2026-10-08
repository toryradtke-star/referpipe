import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedBy, contactFor, contactLinks, decodeCfEmail, extractEmails, listingFacts, robotsDisallows, siteFacts } from './enrich.ts';
import type { Business } from './types.ts';

const html = readFileSync(new URL('./fixtures/site-home.html', import.meta.url), 'utf8');

test('emails: mailto, entity-encoded, Cloudflare-protected; junk dropped', () => {
  const found = Object.fromEntries(extractEmails(html).map((e) => [e.email, e.via]));
  assert.equal(found['front.desk@lakesidechiro.example'], 'mailto');
  assert.equal(found['billing@lakesidechiro.example'], 'text');
  assert.equal(found['dr.e@gmail.com'], 'cf');
  assert.equal(Object.keys(found).length, 3, `unexpected: ${Object.keys(found)}`);
});

test('cfemail decodes', () => {
  assert.equal(decodeCfEmail('3a5e48145f7a5d575b535614595557'), 'dr.e@gmail.com');
});

test('contact kind and confidence', () => {
  assert.deepEqual(contactFor('info@acme.com', 'u', 'acme.com', 'text'), { email: 'info@acme.com', sourceUrl: 'u', kind: 'generic', confidence: 'high' });
  assert.equal(contactFor('jo@gmail.com', 'u', 'acme.com', 'text').confidence, 'medium');
  assert.equal(contactFor('jo@gmail.com', 'u', 'acme.com', 'mailto').kind, 'person');
});

test('contact links: same site only, contact/about pages', () => {
  const links = contactLinks(html, 'https://lakesidechiro.example/');
  assert.deepEqual(links, ['https://lakesidechiro.example/contact-us/', 'https://lakesidechiro.example/about']);
});

test('site facts: the gaps a pitch can cite', () => {
  const { facts, cms } = siteFacts(html, { finalUrl: 'http://lakesidechiro.example/', year: 2026, responseMs: 5200 });
  const by = Object.fromEntries(facts.map((f) => [f.id, f]));
  assert.equal(cms, 'WordPress');
  assert.equal(by['site.https'].ok, false);
  assert.equal(by['site.viewport'].ok, false);
  assert.equal(by['site.analytics'].ok, false);
  assert.match(by['site.analytics'].text, /Universal Analytics/);
  assert.equal(by['site.copyright'].value, 2019);
  assert.equal(by['site.copyright'].ok, false);
  assert.equal(by['site.click_to_call'].ok, false);
  assert.equal(by['site.response_ms'].ok, false);
  assert.equal(by['site.title'].ok, true);
});

test('site facts: a modern site reads as fine', () => {
  const good = `<html><head><title>Northside Fitness — Sauk Centre</title><meta name="viewport" content="width=device-width">
    <meta name="description" content="24/7 gym in Sauk Centre with classes, coaching and a free first week for new members.">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script>
    <script type="application/ld+json">{"@type":"ExerciseGym"}</script></head>
    <body><a href="tel:+13205550100">Call</a><footer>© 2026</footer></body></html>`;
  const { facts } = siteFacts(good, { finalUrl: 'https://northside.example/', year: 2026 });
  assert.deepEqual(facts.filter((f) => f.ok === false).map((f) => f.id), []);
});

test('robots: our group wins over *, empty Disallow allows', () => {
  const txt = 'User-agent: *\nDisallow: /contact\n\nUser-agent: referpipe\nDisallow:\n';
  assert.deepEqual(robotsDisallows(txt), []);
  const star = robotsDisallows('User-agent: *\nDisallow: /wp-admin/\nDisallow: /private*');
  assert.equal(allowedBy(star, '/wp-admin/x'), false);
  assert.equal(allowedBy(star, '/private-area'), false);
  assert.equal(allowedBy(star, '/contact'), true);
});

test('listing facts: reviews, hours, photos from Places only', () => {
  const b = { source: 'places', reviewCount: 3, rating: 4.9, hoursSet: false, photoCount: 0 } as Business;
  const by = Object.fromEntries(listingFacts(b).map((f) => [f.id, f]));
  assert.equal(by['places.reviews'].ok, false);
  assert.equal(by['places.hours'].ok, false);
  assert.equal(by['places.photos'].text, 'Google listing has no photos');
  assert.deepEqual(listingFacts({ ...b, source: 'osm' }), []);
});

test('role mailboxes are generic, names are people', () => {
  for (const e of ['mediainquiries@x.com', 'vendorsupport@x.com', 'xrays@x.com', 'careers@x.com', 'patientcare@x.com'])
    assert.equal(contactFor(e, 'u', 'x.com', 'text').kind, 'generic', e);
  for (const e of ['brent.jamison@x.com', 'jessann.lake@gmail.com'])
    assert.equal(contactFor(e, 'u', 'x.com', 'text').kind, 'person', e);
});

test('no website: a gap on Google, unknown on OSM', async () => {
  const { auditBusiness } = await import('./enrich.ts');
  const base = { id: 'x', website: null, email: null, mapsUrl: null, reviewCount: 0, rating: null, hoursSet: false, photoCount: 0 } as unknown as Business;
  const g = await auditBusiness({ ...base, source: 'places' });
  assert.equal(g.siteStatus, 'none');
  assert.equal(g.facts.find((f) => f.id === 'site.none')?.ok, false);
  const o = await auditBusiness({ ...base, source: 'osm' });
  assert.equal(o.siteStatus, 'unknown');
  assert.ok(!o.facts.some((f) => f.ok === false));
});

test('down sites say what was observed', async () => {
  const { downCause, downText } = await import('./enrich.ts');
  const { HttpError } = await import('./sources/http.ts');
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.equal(downCause(dns), 'dns');
  assert.match(downText('x.com', dns), /no longer points anywhere/);
  assert.equal(downCause(new HttpError(404)), '404');
  assert.equal(downCause(new HttpError(503)), '5xx');
});

test('a short description or title says what is wrong with it', () => {
  const { facts } = siteFacts('<title>Home</title><meta name="description" content="Massage in Hudson">', { finalUrl: 'https://x/' });
  const by = Object.fromEntries(facts.map((f) => [f.id, f]));
  assert.equal(by['site.description'].ok, false);
  assert.match(by['site.description'].text, /only 17 characters/);
  assert.match(by['site.title'].text, /just "Home"/);
});
