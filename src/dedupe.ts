/**
 * The same business, found twice.
 *
 * Places and OSM list the same chiropractor; Places lists a gym under "gym"
 * and again under "personal trainer"; a search for one town returns a
 * business in the next town that a later search finds again. Without this the
 * judge reads it twice and the business gets two emails.
 *
 * Copies are joined when any key matches: phone number, website domain, or
 * normalized name in the same town. Names alone are not enough across towns
 * (there is a "Main Street Dental" in half the state). Domains that are
 * someone else's platform (facebook.com) never join two businesses.
 *
 * As in jobpipe, dedupe runs after the screen and only among copies that
 * passed it, so a ruled-out copy can never shadow a good one.
 */
import { domainOf, phoneDigits, SOCIAL_HOSTS } from './normalize.ts';

const NAME_NOISE = /\b(llc|l\.l\.c|inc|incorporated|co|company|corp|ltd|pllc|pa|p\.a|the|and|&)\b\.?/g;

export function normalizeName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(NAME_NOISE, ' ').replace(/[^a-z0-9]+/g, '');
}

export type Candidate = {
  id: string; source: string; name: string; town: string; phone: string | null; website: string | null;
  firstSeen: string; enriched: boolean; judged: boolean;
};

export function keys(c: Candidate): string[] {
  const out = [`name:${normalizeName(c.name)}|${c.town.toLowerCase()}`];
  const phone = phoneDigits(c.phone);
  if (phone) out.push(`phone:${phone}`);
  const domain = domainOf(c.website);
  if (domain && !SOCIAL_HOSTS.test(domain)) out.push(`domain:${domain}`);
  return out;
}

const SOURCE_RANK: Record<string, number> = { places: 0, osm: 1 };

/** Places first (reviews, hours, photos), then already judged, enriched, earliest. */
export function preferred<T extends Candidate>(copies: T[]): T {
  return [...copies].sort((a, b) =>
    Number(b.judged) - Number(a.judged)
    || (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
    || Number(b.enriched) - Number(a.enriched)
    || a.firstSeen.localeCompare(b.firstSeen)
    || a.id.localeCompare(b.id))[0];
}

/** Groups of copies that share any key (union-find). Singletons are left out. */
export function groups<T extends Candidate>(cands: T[]): T[][] {
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  cands.forEach((c, i) => {
    for (const k of keys(c)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const byRoot = new Map<number, T[]>();
  cands.forEach((c, i) => { const r = find(i); byRoot.set(r, [...(byRoot.get(r) ?? []), c]); });
  return [...byRoot.values()].filter((g) => g.length > 1);
}
