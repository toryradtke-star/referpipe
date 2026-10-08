/**
 * Google Places API (New), Text Search.
 *
 * One query per category per town ("chiropractor in Alexandria, MN"), up to
 * three pages of twenty. The field mask asks only for what the audit and the
 * screen use. Phone, website, rating and hours put the request in a pricier
 * SKU than name and address alone, so a poll is metered by slices of the
 * target grid and the Cloud project should carry a budget alert and a quota.
 *
 * Terms of service: place ids may be kept indefinitely; the rest of what
 * Places returns may be cached for at most 30 days. The store purges those
 * fields from rows a poll has not refreshed in that time (Store.purgeStalePlaces).
 */
import type { Business, Category, Town } from '../types.ts';
import { request } from './http.ts';
import { websiteUrl } from '../normalize.ts';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

export const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents',
  'places.nationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.regularOpeningHours.weekdayDescriptions', 'places.photos.name', 'places.googleMapsUri',
  'places.businessStatus', 'nextPageToken',
].join(',');

type Component = { longText?: string; shortText?: string; types?: string[] };

export function parse(body: any, category: Category, now: string): Business[] {
  return (body?.places ?? []).map((p: any): Business => {
    const comp = (type: string) => (p.addressComponents as Component[] | undefined)?.find((c) => c.types?.includes(type));
    return {
      id: `places:${p.id}`,
      source: 'places',
      externalId: p.id,
      name: p.displayName?.text ?? '(no name)',
      category: category.key,
      town: comp('locality')?.longText ?? comp('administrative_area_level_3')?.longText ?? '',
      state: comp('administrative_area_level_1')?.shortText ?? '',
      address: p.formattedAddress ?? null,
      phone: p.nationalPhoneNumber ?? null,
      website: websiteUrl(p.websiteUri),
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
      hoursSet: !!p.regularOpeningHours?.weekdayDescriptions?.length,
      hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
      photoCount: Array.isArray(p.photos) ? p.photos.length : 0,
      mapsUrl: p.googleMapsUri ?? null,
      status: p.businessStatus ?? null,
      brand: null,
      email: null,
      firstSeen: now,
      lastSeen: now,
    };
  });
}

export async function search(category: Category, town: Town,
  opts: { key: string; now: string; pages?: number; timeoutMs?: number }): Promise<{ businesses: Business[]; requests: number }> {
  const out: Business[] = [];
  let pageToken: string | undefined;
  let requests = 0;
  for (let page = 0; page < (opts.pages ?? 3); page++) {
    const res = await request(ENDPOINT, {
      timeoutMs: opts.timeoutMs,
      headers: { 'X-Goog-Api-Key': opts.key, 'X-Goog-FieldMask': FIELD_MASK },
      body: { textQuery: `${category.places} in ${town.name}, ${town.state}`, pageSize: 20, regionCode: 'US', ...(pageToken ? { pageToken } : {}) },
    });
    requests++;
    const body = await res.json() as any;
    out.push(...parse(body, category, opts.now));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return { businesses: out, requests };
}
