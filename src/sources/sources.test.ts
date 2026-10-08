import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as places from './places.ts';
import * as osm from './osm.ts';
import type { Category } from '../types.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const chiro: Category = { key: 'chiropractor', label: 'Chiropractor', places: 'chiropractor', osm: ['healthcare=chiropractor'] };

test('places: reads town, state, listing signals and status', () => {
  const [a, b] = places.parse(fixture('places-search.json'), chiro, '2026-10-05T00:00:00Z');
  assert.equal(a.id, 'places:ChIJtest001');
  assert.equal(a.town, 'Alexandria');
  assert.equal(a.state, 'MN');
  assert.equal(a.website, 'http://lakesidechiro.example/');
  assert.equal(a.reviewCount, 12);
  assert.equal(a.photoCount, 2);
  assert.equal(a.hoursSet, false);
  assert.equal(b.state, 'WI');
  assert.equal(b.website, null);
  assert.equal(b.hoursSet, true);
  assert.equal(b.reviewCount, 0);
  assert.equal(b.status, 'CLOSED_TEMPORARILY');
});

test('places: field mask stays narrow', () => {
  assert.ok(!places.FIELD_MASK.includes('reviews'), 'review text is never requested');
  assert.ok(places.FIELD_MASK.includes('nextPageToken'));
});

test('osm: scopes the town inside its state', () => {
  const q = osm.query([chiro], { name: 'Alexandria', state: 'MN' });
  assert.match(q, /"ISO3166-2"="US-MN"/);
  assert.match(q, /rel\(area\.st\)/);
  assert.match(q, /\["healthcare"="chiropractor"\]\["name"\]/);
});

test('osm: maps tags to businesses (real Alexandria, MN response)', () => {
  const cats: Category[] = [
    { key: 'salon', label: 'Salon', places: 'hair salon', osm: ['shop=hairdresser'] },
    { key: 'dentist', label: 'Dentist', places: 'dentist', osm: ['amenity=dentist'] },
  ];
  const list = osm.parse(fixture('overpass-alexandria.json'), cats, { name: 'Alexandria', state: 'MN' }, 'now');
  const clips = list.find((b) => b.name === 'Great Clips')!;
  assert.equal(clips.brand, 'Great Clips');
  assert.equal(clips.category, 'salon');
  assert.equal(clips.website, 'https://www.greatclips.com/');
  const dental = list.find((b) => b.name === 'Gentle Dentistry')!;
  assert.equal(dental.category, 'dentist');
  assert.equal(dental.state, 'MN');
  assert.equal(dental.website, null);
});

test('osm: town names match how OSM spells them', () => {
  const re = (n: string) => new RegExp(osm.nameRegex(n).replace(/\\\\/g, '\\'), 'i');
  assert.ok(re('St. Cloud').test('Saint Cloud'));
  assert.ok(re('St. Cloud').test('St. Cloud'));
  assert.ok(re('Superior').test('City of Superior'));
  assert.ok(!re('Superior').test('Town of Superior'));
  assert.ok(!re('Superior').test('Lake Superior'));
});
