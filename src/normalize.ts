/**
 * Small text helpers shared by the sources, the audit and dedupe.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•', copy: '©',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** HTML to plain text: scripts and styles dropped, entities decoded, blank lines collapsed. (From jobpipe.) */
export function htmlToText(html: string): string {
  if (!html) return '';
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/footer|\/header)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/** The last ten digits of a US phone number, or null. */
export function phoneDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

export function formatPhone(raw: string | null | undefined): string | null {
  const d = phoneDigits(raw);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (raw ?? null);
}

/** example.com from any URL, without www. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

/** A website value as a fetchable URL. OSM often stores "example.com". */
export function websiteUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const v = raw.trim();
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

/** Hosts that are someone else's platform, not the business's own website. */
export const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linktr\.ee|yelp\.com|google\.com|business\.site|g\.page|nextdoor\.com|tiktok\.com|x\.com|twitter\.com|linkedin\.com|mapquest\.com|yellowpages\.com|bbb\.org)$/i;

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/&/g, 'and')
    .replace(/[\s_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Every number in a text, without thousands separators: what the grounding checks compare. */
export function numbers(text: string): string[] {
  return [...text.matchAll(/\d[\d,.]*/g)].map((m) => m[0].replace(/[,.]+$/, '').replace(/,/g, ''));
}
