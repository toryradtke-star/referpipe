import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groups, normalizeName, preferred, type Candidate } from './dedupe.ts';

const c = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, source: 'places', name: 'X', town: 'Alexandria', phone: null, website: null, firstSeen: '2026-10-01', enriched: false, judged: false, ...over,
});

test('names normalize away suffixes and punctuation', () => {
  assert.equal(normalizeName("Bob's Plumbing, LLC"), normalizeName('Bobs Plumbing'));
});

test('joins on phone, domain, or name in the same town; transitively', () => {
  const g = groups([
    c('places:1', { name: 'Bayview Dental', phone: '+1-320-763-5052' }),
    c('osm:node/2', { source: 'osm', name: 'Bayview Dental PA', phone: '(320) 763-5052', website: 'bayviewdental.example' }),
    c('places:3', { name: 'Bayview Dental Care', website: 'https://www.bayviewdental.example/' }),
    c('places:4', { name: 'Main Street Dental', town: 'Alexandria' }),
    c('places:5', { name: 'Main Street Dental', town: 'Willmar' }),
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].map((x) => x.id).sort(), ['osm:node/2', 'places:1', 'places:3']);
});

test('facebook pages never join two businesses', () => {
  assert.equal(groups([c('a', { name: 'A', website: 'https://facebook.com/a' }), c('b', { name: 'B', website: 'https://facebook.com/b' })]).length, 0);
});

test('preferred: judged, then Places, then enriched, then earliest', () => {
  assert.equal(preferred([c('osm:1', { source: 'osm' }), c('places:2')]).id, 'places:2');
  assert.equal(preferred([c('osm:1', { source: 'osm', judged: true }), c('places:2')]).id, 'osm:1');
  assert.equal(preferred([c('places:1', { firstSeen: '2026-10-03' }), c('places:2', { firstSeen: '2026-10-02' })]).id, 'places:2');
});
