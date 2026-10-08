/**
 * OpenStreetMap through the Overpass API. Free and open, and thin in rural
 * Minnesota: Alexandria had three tagged businesses across five categories
 * when this was written. It is a supplement to Places, not a replacement.
 *
 * A search is one town's administrative boundary, found inside its state so
 * Alexandria, MN is not confused with Alexandria, VA (it was, the first time).
 */
import type { Business, Category, Town } from '../types.ts';
import { request } from './http.ts';
import { websiteUrl } from '../normalize.ts';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * OSM names boundaries as the state does: "Saint Cloud", not "St. Cloud";
 * "City of Superior" in Wisconsin. Both spellings are matched, and WI's
 * "City of"/"Village of" prefixes (but not "Town of", which is the rural
 * township around the city).
 */
export function nameRegex(name: string): string {
  const core = name.replace(/["\\]/g, '').replace(/[.*+?^${}()|[\]]/g, '\\\\$&')
    .replace(/^St\\\\\.\s+/i, '(St\\\\.?|Saint) ');
  return `^((City|Village) of )?${core}$`;
}

export function query(categories: Category[], town: Town): string {
  const tags = [...new Set(categories.flatMap((c) => c.osm))];
  const clauses = tags.map((t) => {
    const [k, v] = t.split('=');
    return `nwr(area.t)["${k}"="${v}"]["name"];`;
  }).join('');
  return `[out:json][timeout:90];area["ISO3166-2"="US-${town.state}"]["admin_level"="4"]->.st;`
    + `rel(area.st)["boundary"="administrative"]["name"~"${nameRegex(town.name)}",i];map_to_area->.t;`
    + `(${clauses});out tags center;`;
}

/** Which of the searched categories an element's tags belong to. */
function categoryOf(tags: Record<string, string>, categories: Category[]): Category | undefined {
  return categories.find((c) => c.osm.some((t) => { const [k, v] = t.split('='); return tags[k] === v; }));
}

export function parse(body: any, categories: Category[], town: Town, now: string): Business[] {
  const out: Business[] = [];
  for (const e of body?.elements ?? []) {
    const t = e.tags ?? {};
    const category = categoryOf(t, categories);
    if (!category || !t.name) continue;
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    out.push({
      id: `osm:${e.type}/${e.id}`,
      source: 'osm',
      externalId: `${e.type}/${e.id}`,
      name: t.name,
      category: category.key,
      town: t['addr:city'] ?? town.name,
      state: t['addr:state'] ?? town.state,
      address: [street, t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(', ') || null,
      phone: t.phone ?? t['contact:phone'] ?? null,
      website: websiteUrl(t.website ?? t['contact:website']),
      rating: null,
      reviewCount: null,
      hoursSet: t.opening_hours ? true : null,
      hours: t.opening_hours ? [t.opening_hours] : null,
      photoCount: null,
      mapsUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      status: null,
      brand: t.brand ?? null,
      email: t.email ?? t['contact:email'] ?? null,
      firstSeen: now,
      lastSeen: now,
    });
  }
  return out;
}

export async function search(categories: Category[], town: Town, opts: { now: string; timeoutMs?: number }): Promise<Business[]> {
  const res = await request(ENDPOINT, { form: { data: query(categories, town) }, timeoutMs: opts.timeoutMs ?? 120_000 });
  return parse(await res.json(), categories, town, opts.now);
}
