/**
 * The audit: what a business's web presence looks like from the outside.
 *
 * Every finding is a Fact with an id. The judge and the pitch may only cite
 * facts by id, and the pitch is fact-checked against them, so nothing in an
 * email is a claim this file did not actually observe.
 *
 * Contacts come only from what the business publishes: mailto links, emails
 * written on their own pages, Cloudflare's obfuscated emails decoded, and an
 * OSM email tag. Addresses are never guessed (first.last@...), because a
 * guessed address that bounces costs the sending domain's reputation and a
 * guessed one that lands is a cold email to someone who never published it.
 *
 * Crawling is polite: robots.txt is read and obeyed, at most five pages per
 * site, one site at a time per worker.
 */
import type { Audit, Business, Contact, Fact } from './types.ts';
import { HttpError, request, USER_AGENT } from './sources/http.ts';
import { decodeEntities, domainOf, htmlToText, SOCIAL_HOSTS } from './normalize.ts';

const MAX_PAGES = 5;
const SITE_TEXT_CHARS = 9_000;

// ---------------------------------------------------------------- emails

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const JUNK_EMAIL_DOMAIN = /(^|\.)(example\.(com|org)|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com|domain\.com|yourdomain\.com|email\.com|squarespace\.com|godaddy\.com|schema\.org|w3\.org|mysite\.com|company\.com|website\.com|sentry\.wixpress\.com|wix\.com|weebly\.com|duda\.co)$/i;
const JUNK_EMAIL_LOCAL = /^(user|name|email|your|yourname|you|first\.last|firstname|john\.?doe|jane\.?doe|test|noreply|no-reply|donotreply|do-not-reply)$/i;
const ASSET = /\.(png|jpe?g|gif|webp|svg|avif|css|js)$/i;
const GENERIC_LOCAL = /^(info|contact|hello|hi|office|admin|support|sales|frontdesk|front\.desk|reception|appointments?|booking|bookings|service|team|mail|inquiries|enquiries|help|general|billing|scheduling|customerservice|care)$/i;
/** Role mailboxes that are not in the plain list: media@, vendorsupport@, xrays@, careers@. */
const ROLE_PREFIX = /^(media|press|marketing|careers?|jobs|hr|vendor|accounts?|accounting|records|x-?rays?|orders?|parts|shop|estimates?|quotes?|service|support|inquir|enquir|webmaster|frontdesk|patient|referrals?)/i;
const isGeneric = (local: string) => GENERIC_LOCAL.test(local) || ROLE_PREFIX.test(local);

/** Cloudflare's email protection: hex, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function cleanEmail(raw: string): string | null {
  const e = decodeURIComponent(raw).trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
  const m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,24})$/.exec(e);
  if (!m) return null;
  if (ASSET.test(e) || JUNK_EMAIL_DOMAIN.test(m[2]) || JUNK_EMAIL_LOCAL.test(m[1])) return null;
  // Hashes Sentry and friends embed in bundles: long hex local parts.
  if (/^[a-f0-9]{16,}$/.test(m[1])) return null;
  return e;
}

/** Every email a page publishes, with how it was published. */
export function extractEmails(html: string): { email: string; via: 'mailto' | 'text' | 'cf' }[] {
  const found = new Map<string, 'mailto' | 'text' | 'cf'>();
  const add = (raw: string, via: 'mailto' | 'text' | 'cf') => {
    const e = cleanEmail(raw);
    if (e && (!found.has(e) || via === 'mailto')) found.set(e, via);
  };
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"']+)["']/gi)) add(decodeEntities(m[1]), 'mailto');
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]), 'cf');
  for (const m of htmlToText(html).matchAll(EMAIL)) add(m[0], 'text');
  return [...found].map(([email, via]) => ({ email, via }));
}

export function contactFor(email: string, sourceUrl: string, siteDomain: string | null, via: string): Contact {
  const [local, domain] = email.split('@');
  return {
    email, sourceUrl,
    kind: isGeneric(local) ? 'generic' : 'person',
    // On the business's own domain, or linked as mailto: it is theirs.
    confidence: (siteDomain && (domain === siteDomain || domain.endsWith(`.${siteDomain}`))) || via === 'mailto' || via === 'cf' ? 'high' : 'medium',
  };
}

// ---------------------------------------------------------------- robots

/** Disallow rules that apply to us: our own group if there is one, else `*`. */
export function robotsDisallows(txt: string): string[] {
  const groups: { agents: string[]; disallow: string[]; allow: string[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (/^user-agent$/i.test(key)) {
      if (!cur || !lastWasAgent) { cur = { agents: [], disallow: [], allow: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (/^disallow$/i.test(key) && value) cur.disallow.push(value);
    }
  }
  const ours = groups.find((g) => g.agents.some((a) => a.includes('referpipe')));
  return (ours ?? groups.find((g) => g.agents.includes('*')))?.disallow ?? [];
}

export function allowedBy(disallow: string[], path: string): boolean {
  return !disallow.some((d) => {
    const prefix = d.replace(/\*.*$/, '').replace(/\$$/, '');
    return prefix === '' ? false : path.startsWith(prefix);
  });
}

// ---------------------------------------------------------------- site facts

const CMS: [string, RegExp][] = [
  ['Wix', /static\.wixstatic\.com|wix-code|_wixCssImports|x-wix-/i],
  ['Squarespace', /static1\.squarespace\.com|squarespace-cdn|Squarespace\./i],
  ['GoDaddy Website Builder', /img1\.wsimg\.com|godaddy website builder|websites\.godaddy/i],
  ['WordPress', /wp-content\/|wp-includes\//i],
  ['Weebly', /weebly\.com|editmysite\.com/i],
  ['Duda', /dudaone|multiscreensite|irp\.cdn-website\.com|dmcdn\./i],
  ['Shopify', /cdn\.shopify\.com/i],
  ['Webflow', /webflow\.(com|io)|data-wf-page/i],
  ['Hibu', /hibu/i],
];

const PARKED = /(this domain (is|may be) for sale|domain is parked|buy this domain|parkingcrew|sedoparking|hugedomains|afternic|domain has expired|this domain has been registered)/i;

/** What the home page's HTML says about the site. Pure, so it can be tested on saved pages. */
export function siteFacts(html: string, opts: { finalUrl: string; headers?: string; responseMs?: number; year?: number }): { facts: Fact[]; cms: string | null } {
  const year = opts.year ?? new Date().getFullYear();
  const facts: Fact[] = [];
  const f = (id: string, ok: boolean | null, text: string, value?: Fact['value']) => facts.push({ id, ok, text, value, source: 'site' });
  const blob = `${opts.headers ?? ''}\n${html}`;

  const https = opts.finalUrl.startsWith('https://');
  f('site.https', https, https ? 'Site loads over HTTPS' : 'Site loads without HTTPS, so browsers mark it "Not secure"', https);

  const viewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html);
  f('site.viewport', viewport, viewport ? 'Site declares a mobile viewport' : 'Site has no mobile viewport tag, so phones show the desktop layout shrunk down', viewport);

  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  f('site.title', title.length >= 10,
    !title ? 'Home page has no title tag'
      : title.length < 10 ? `Home page title is just "${title}", which tells Google almost nothing`
        : `Home page title is "${title.slice(0, 80)}"`, title || null);

  const desc = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(html)?.[1] ?? '';
  const d = decodeEntities(desc).trim();
  f('site.description', d.length >= 50,
    !d ? 'Home page has no meta description, so Google writes its own snippet'
      : d.length < 50 ? `Home page meta description is only ${d.length} characters ("${d}")`
        : 'Home page has a meta description', d.length);

  const ga4 = /gtag\/js\?id=G-|['"]G-[A-Z0-9]{6,}['"]/i.test(html);
  const gtm = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i.test(html);
  const ua = /UA-\d{4,}-\d+/.test(html) && !ga4;
  const analytics = ga4 || gtm;
  f('site.analytics', analytics,
    analytics ? `Site has ${ga4 ? 'Google Analytics 4' : 'Google Tag Manager'} installed`
      : ua ? 'Site only has the old Universal Analytics tag, which stopped collecting data in 2023'
        : 'No Google Analytics or Tag Manager found on the home page', analytics);

  const ads = /AW-\d{6,}/.test(html);
  f('site.ads_tag', ads ? true : null, ads ? 'A Google Ads conversion tag is present' : 'No Google Ads conversion tag found', ads);
  const pixel = /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init/i.test(html);
  f('site.meta_pixel', pixel ? true : null, pixel ? 'A Meta (Facebook) pixel is present' : 'No Meta pixel found', pixel);

  const years = [...htmlToText(html).matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  if (years.length) {
    const y = Math.max(...years);
    f('site.copyright', y >= year - 1, `Footer copyright year is ${y}`, y);
  }

  const cms = CMS.find(([, re]) => re.test(blob))?.[0] ?? null;
  if (cms) f('site.cms', null, `Built on ${cms}`, cms);

  const schema = /"@type"\s*:\s*"(LocalBusiness|HealthAndBeautyBusiness|MedicalBusiness|Dentist|Physician|HomeAndConstructionBusiness|Plumber|HVACBusiness|RoofingContractor|Electrician|SportsActivityLocation|ExerciseGym|HealthClub|HairSalon|BeautySalon|DaySpa|AutoRepair|ProfessionalService|MedicalClinic|Chiropractic|Physiotherapy|Optician|Organization)"/i.test(html);
  f('site.schema', schema, schema ? 'Home page has structured business data (schema.org)' : 'No structured business data (schema.org) for Google to read', schema);

  const tel = /href\s*=\s*["']tel:/i.test(html);
  f('site.click_to_call', tel, tel ? 'Phone number is tap-to-call' : 'Phone number is not a tap-to-call link', tel);

  if (opts.responseMs !== undefined) {
    f('site.response_ms', opts.responseMs < 1500 ? true : opts.responseMs > 4000 ? false : null,
      `Home page took ${(opts.responseMs / 1000).toFixed(1)}s to answer`, opts.responseMs);
  }
  return { facts, cms };
}

/** Facts from the listing itself: reviews, hours, photos. */
export function listingFacts(b: Business): Fact[] {
  const facts: Fact[] = [];
  const src = b.source === 'places' ? 'places' : 'osm';
  if (b.source === 'places') {
    const n = b.reviewCount ?? 0;
    facts.push({ id: 'places.reviews', ok: n >= 25, value: n, source: src,
      text: n ? `${n} Google review${n === 1 ? '' : 's'}${b.rating ? `, rated ${b.rating.toFixed(1)}` : ''}` : 'No Google reviews yet' });
    if (b.rating !== null) facts.push({ id: 'places.rating', ok: b.rating >= 4.3, value: b.rating, source: src, text: `Rated ${b.rating.toFixed(1)} on Google` });
    facts.push({ id: 'places.hours', ok: !!b.hoursSet, value: !!b.hoursSet, source: src,
      text: b.hoursSet ? 'Hours are set on the Google listing' : 'No hours set on the Google listing' });
    const p = b.photoCount ?? 0;
    facts.push({ id: 'places.photos', ok: p >= 5, value: p, source: src,
      text: p >= 10 ? 'Google listing has 10+ photos' : p ? `Google listing has ${p} photo${p === 1 ? '' : 's'}` : 'Google listing has no photos' });
  }
  return facts;
}

// ---------------------------------------------------------------- crawl

type Page = { url: string; html: string; headers: string; ms: number };

async function getPage(url: string, timeoutMs: number): Promise<Page> {
  const t = Date.now();
  const res = await request(url, { accept: 'text/html,application/xhtml+xml', timeoutMs, retries: 1 });
  const type = res.headers.get('content-type') ?? '';
  const html = /html|xml|text\/plain/i.test(type) || !type ? (await res.text()).slice(0, 1_500_000) : '';
  return { url: res.url || url, html, headers: [...(res.headers as unknown as Iterable<[string, string]>)].map(([k, v]) => `${k}: ${v}`).join('\n'), ms: Date.now() - t };
}

/** Same-site links that look like a contact, about or location page. */
export function contactLinks(html: string, base: string): string[] {
  const host = domainOf(base);
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, label] = m;
    if (!/contact|about|team|staff|location|appointment|book|reach|find-us|our-story|meet/i.test(`${href} ${htmlToText(label)}`)) continue;
    try {
      const u = new URL(decodeEntities(href), base);
      if (!/^https?:$/.test(u.protocol) || domainOf(u.href) !== host) continue;
      u.hash = '';
      if (!out.includes(u.href) && u.href !== base) out.push(u.href);
    } catch { /* not a URL */ }
  }
  return out.slice(0, MAX_PAGES - 1);
}

async function psi(url: string, key: string | undefined, timeoutMs: number): Promise<Fact[]> {
  const q = new URLSearchParams({ url, strategy: 'mobile' });
  q.append('category', 'performance');
  q.append('category', 'seo');
  if (key) q.set('key', key);
  const res = await request(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { timeoutMs, retries: 1 });
  const body = await res.json() as any;
  const cats = body?.lighthouseResult?.categories ?? {};
  const audits = body?.lighthouseResult?.audits ?? {};
  const facts: Fact[] = [];
  if (typeof cats.performance?.score === 'number') {
    const s = Math.round(cats.performance.score * 100);
    facts.push({ id: 'psi.mobile_performance', ok: s >= 90 ? true : s < 50 ? false : null, value: s, source: 'psi',
      text: `Google PageSpeed mobile performance score is ${s}/100` });
  }
  if (typeof cats.seo?.score === 'number') {
    const s = Math.round(cats.seo.score * 100);
    facts.push({ id: 'psi.seo', ok: s >= 90 ? true : s < 80 ? false : null, value: s, source: 'psi',
      text: `Google PageSpeed SEO score is ${s}/100` });
  }
  const lcp = audits['largest-contentful-paint']?.numericValue;
  if (typeof lcp === 'number') {
    facts.push({ id: 'psi.lcp', ok: lcp <= 2500 ? true : lcp > 4000 ? false : null, value: Math.round(lcp), source: 'psi',
      text: `On a phone, the main content takes ${(lcp / 1000).toFixed(1)}s to appear` });
  }
  return facts;
}

/** Why a site failed, as a short code: dns, 404, 5xx, timeout, tls, network. */
export function downCause(err: unknown): string {
  if (err instanceof HttpError) return err.status >= 500 ? '5xx' : String(err.status);
  const code = (err as any)?.cause?.code ?? (err as any)?.name ?? '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/Timeout|Abort/i.test(code)) return 'timeout';
  if (/CERT|SSL|TLS/i.test(code)) return 'tls';
  return 'network';
}

/** Says what was observed, nothing more: "did not load" claims less than "is down". */
export function downText(domain: string, err: unknown): string {
  switch (downCause(err)) {
    case 'dns': return `The listed website's domain (${domain}) no longer points anywhere`;
    case '404': return `The listed website's home page (${domain}) answers "not found" (HTTP 404), which tells Google there is no page`;
    case '5xx': return `The listed website (${domain}) returned a server error when checked`;
    case 'tls': return `The listed website (${domain}) has a broken security certificate`;
    case 'timeout': return `The listed website (${domain}) did not answer within 20 seconds`;
    default: return `The listed website (${domain}) did not load when checked`;
  }
}

export async function auditBusiness(b: Business, opts: { psiKey?: string; psi?: boolean; timeoutMs?: number } = {}): Promise<Audit> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const facts: Fact[] = listingFacts(b);
  const contacts = new Map<string, Contact>();
  if (b.email) {
    const e = cleanEmail(b.email);
    if (e) contacts.set(e, { email: e, sourceUrl: b.mapsUrl ?? 'osm', kind: isGeneric(e.split('@')[0]) ? 'generic' : 'person', confidence: 'medium' });
  }
  const audit: Audit = { businessId: b.id, auditedAt: new Date().toISOString(), finalUrl: null, siteStatus: 'none', psiMobile: null, cms: null, siteText: null, facts, contacts: [] };
  const done = () => { audit.contacts = [...contacts.values()]; return audit; };

  if (!b.website) {
    // Only Google's silence is evidence. An OSM node without a website tag
    // just means no mapper added one; "you have no website" said to a
    // business that has one ends the conversation.
    if (b.source === 'places') {
      facts.push({ id: 'site.none', ok: false, source: 'places', text: 'No website listed on the Google listing' });
    } else {
      audit.siteStatus = 'unknown';
      facts.push({ id: 'site.unknown', ok: null, source: 'osm', text: 'OpenStreetMap lists no website; unknown until Places or a manual check' });
    }
    return done();
  }
  if (SOCIAL_HOSTS.test(domainOf(b.website) ?? '')) {
    audit.siteStatus = 'social-only';
    audit.finalUrl = b.website;
    facts.push({ id: 'site.social_only', ok: false, source: 'site', value: domainOf(b.website),
      text: `The website link goes to ${domainOf(b.website)}, not a site the business owns` });
    return done();
  }

  let home: Page;
  try {
    home = await getPage(b.website, timeoutMs);
  } catch (err) {
    // A site that refuses a bot is not a broken site; saying "your site is
    // down" to an owner whose site works would end the conversation.
    if (err instanceof HttpError && [401, 403, 429].includes(err.status)) {
      audit.siteStatus = 'blocked';
      facts.push({ id: 'site.blocked', ok: null, source: 'site', value: err.status, text: `The site refused an automated check (http ${err.status}); check it by hand` });
      return done();
    }
    audit.siteStatus = 'down';
    facts.push({ id: 'site.down', ok: false, source: 'site', value: downCause(err), text: downText(domainOf(b.website)!, err) });
    return done();
  }
  audit.finalUrl = home.url;
  if (PARKED.test(htmlToText(home.html).slice(0, 5000))) {
    audit.siteStatus = 'parked';
    facts.push({ id: 'site.parked', ok: false, source: 'site', text: `The listed website (${domainOf(b.website)}) shows a parked or for-sale domain page` });
    return done();
  }
  audit.siteStatus = 'ok';
  const { facts: sf, cms } = siteFacts(home.html, { finalUrl: home.url, headers: home.headers, responseMs: home.ms });
  facts.push(...sf);
  audit.cms = cms;

  // robots.txt, then the contact-ish pages it allows.
  let disallow: string[] = [];
  try {
    const r = await request(new URL('/robots.txt', home.url).href, { accept: 'text/plain', timeoutMs: 10_000, retries: 0 });
    disallow = robotsDisallows(await r.text());
  } catch { /* no robots.txt: everything allowed */ }
  const siteDomain = domainOf(home.url);
  const pages: Page[] = [home];
  for (const link of contactLinks(home.html, home.url)) {
    if (!allowedBy(disallow, new URL(link).pathname)) continue;
    try { pages.push(await getPage(link, timeoutMs)); } catch { /* one dead link is not a dead site */ }
  }
  audit.siteText = pages.map((p) => `### ${p.url}\n${htmlToText(p.html)}`).join('\n\n').slice(0, SITE_TEXT_CHARS);
  for (const p of pages) {
    for (const { email, via } of extractEmails(p.html)) {
      if (!contacts.has(email)) contacts.set(email, contactFor(email, p.url, siteDomain, via));
    }
  }

  if (opts.psi) {
    try {
      const pf = await psi(home.url, opts.psiKey, 90_000);
      facts.push(...pf);
      audit.psiMobile = Number(pf.find((x) => x.id === 'psi.mobile_performance')?.value ?? NaN) || null;
    } catch (err) {
      // Google's reason is inside a JSON body; keep it readable ("blocked" means the key's API restrictions).
      const raw = err instanceof Error ? err.message : String(err);
      const reason = /"message":\s*"([^"]+)/.exec(raw)?.[1] ?? raw;
      facts.push({ id: 'psi.error', ok: null, source: 'psi', text: `PageSpeed check failed: ${reason.slice(0, 160)}` });
    }
  }
  return done();
}

export { USER_AGENT };
