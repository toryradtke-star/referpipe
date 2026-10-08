/**
 * Outreach: the introduction, the follow-ups, and everything that has to be
 * true before one of them leaves.
 *
 * Claude writes the middle of each email; code writes the rest. The greeting,
 * the signature, the postal address and the unsubscribe line are fixed text,
 * so the parts the law cares about (CAN-SPAM: a real address, a working
 * opt-out, honest headers) never depend on a model. The middle is checked:
 * every number must come from the client's offer or the partner's own site,
 * there are no links, and it stays short.
 *
 * Sending goes through Resend from an outreach subdomain, never the client's
 * main domain, so a spam complaint can't hurt the domain its patients see.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Audit, Business, Contact } from './types.ts';
import { formatPhone, numbers } from './normalize.ts';
import { request } from './sources/http.ts';

export type Sender = {
  fromName: string;
  /** On an outreach subdomain (hello.<client domain>), never the client's main domain. */
  fromEmail: string;
  /** Where replies go: an inbox Tory reads. */
  replyTo: string;
  company: string;
  website: string;
  phone: string;
  /** Required by CAN-SPAM. A PO box is fine. */
  postalAddress: string;
  /** The one-click unsubscribe page, e.g. https://preview.webcraftmn.com/u/ */
  unsubBase: string;
  /** The first day real mail went out; the daily cap ramps from it. */
  warmupStart: string | null;
  /**
   * List-Unsubscribe headers. Gmail reads them as "mailing list" and files the
   * mail under Promotions; they are required only of bulk senders (thousands a
   * day). Off by default: the opt-out in the body satisfies CAN-SPAM.
   */
  listUnsubscribeHeader?: boolean;
  /**
   * Signature lines in place of the default "<first name>" and "<company> · <phone>",
   * e.g. a clinician's name with credentials and a fax line for referrals.
   */
  signature?: string[];
};

export type Drafts = { step1: { subject: string; body: string }; step2: { body: string }; step3: { body: string } };

// ------------------------------------------------------------ recipients

/** Free mail providers: a small business using one is normal. */
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|msn|live|comcast|charter|frontier|centurylink|me|mac|protonmail)\.[a-z.]+$/i;

/**
 * An address on someone else's business domain (a web designer's address on a client's
 * contact page, say): worth a human look before
 * sending. On their own domain or a free mail provider is fine.
 */
export function foreignDomain(email: string, siteDomain: string | null): boolean {
  if (FREE_MAIL.test(email)) return false;
  const d = email.split('@')[1]?.toLowerCase() ?? '';
  return !!siteDomain && d !== siteDomain && !d.endsWith(`.${siteDomain}`) && !siteDomain.endsWith(`.${d}`);
}

/** Their own domain first; then a named person before a role mailbox; a high-confidence address before a medium one. */
export function pickRecipient(contacts: Contact[], suppressed: (v: string) => boolean, siteDomain: string | null = null): Contact | null {
  const rank = (c: Contact) => (foreignDomain(c.email, siteDomain) ? 4 : 0) + (c.confidence === 'high' ? 0 : 2) + (c.kind === 'person' ? 0 : 1);
  return [...contacts].filter((c) => !suppressed(c.email)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ------------------------------------------------------------ unsubscribe

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** `<base64url email>.<16-char HMAC>`: the link carries the address, the signature proves we sent it. */
export function unsubToken(secret: string, email: string): string {
  const e = email.toLowerCase();
  return `${b64url(e)}.${createHmac('sha256', secret).update(e).digest('base64url').slice(0, 16)}`;
}

export function readUnsubToken(secret: string, token: string): string | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const email = Buffer.from(p, 'base64url').toString('utf8');
  const want = createHmac('sha256', secret).update(email).digest('base64url').slice(0, 16);
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? email : null;
}

// ------------------------------------------------------------ the cap

/** 5 a day the first week, 12 the second, 25 after: a new domain earns its reputation slowly. */
export function dailyCap(warmupStart: string | null, now = new Date()): number {
  if (!warmupStart) return 5;
  const days = Math.floor((now.getTime() - Date.parse(warmupStart)) / 86_400_000);
  return days < 7 ? 5 : days < 14 ? 12 : 25;
}

// ------------------------------------------------------------ drafting

const SPAMMY = /\b(free!|act now|limited time|guarantee[d]?|100%|risk[- ]free|no obligation|click here|\$\$|cheap|amazing offer|exclusive deal|urgent)\b/i;

/** What is wrong with a drafted email body, or [] when it may be queued. */
export function emailProblems(body: string, opts: { source: string; link: string | null; maxWords: number; subject?: string }): string[] {
  const problems: string[] = [];
  const known = new Set(numbers(opts.source));
  const text = `${opts.subject ?? ''}\n${body}`;
  const textNoUrl = text.replace(/https?:\/\/\S+/g, '');
  for (const n of numbers(textNoUrl)) if (!known.has(n)) problems.push(`number "${n}" is not in the audit or the site`);
  const urls = text.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
  for (const u of urls) if (u.replace(/[.,;]+$/, '') !== opts.link) problems.push(`link ${u} is not allowed`);
  if (opts.link && !body.includes(opts.link)) problems.push('the link is missing');
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > opts.maxWords) problems.push(`${words} words, over ${opts.maxWords}`);
  const spam = SPAMMY.exec(text);
  if (spam) problems.push(`spam-filter wording: "${spam[0]}"`);
  if (/^(hi|hello|hey|dear)\b/im.test(body.trim().split('\n')[0])) problems.push('starts with a greeting (the code adds it)');
  if (/\n\s*(—|--|best|thanks|cheers|regards|sincerely)[,\s]*\n?\s*([A-Z][a-z]+)?\s*$/i.test(body.trim())) problems.push('ends with a sign-off (the code adds it)');
  if (opts.subject !== undefined) {
    if (opts.subject.length > 60) problems.push('subject over 60 characters');
    if (/[!]|^re:|^fwd?:/i.test(opts.subject)) problems.push('subject has "!" or a fake Re:/Fwd:');
  }
  return problems;
}

/** Everything the email is allowed to state as fact, for the number check. */
export function sourceFor(b: Business, a: Audit, sender: Sender, offer = ''): string {
  return [b.name, b.town, b.address, b.phone, a.facts.map((f) => `${f.text} ${f.value ?? ''}`).join('\n'), a.siteText ?? '',
    sender.phone, sender.company, offer, '15-minute 15 minute 20-minute 20 minute'].join('\n');
}

// ------------------------------------------------------------ the full email

/** The body Claude wrote, wrapped in the parts that are always the same. */
export function compose(body: string, sender: Sender, unsubUrl: string, firstName: string | null = null): string {
  // Written like a person's email, not a newsletter's: a short signature and
  // one plain line carrying the address and the opt-out the law asks for.
  return [
    `Hi ${firstName ?? 'there'},`, '', body.trim(), '',
    ...(sender.signature?.length ? sender.signature : [
      sender.fromName.split(' ')[0],
      `${sender.company} · ${formatPhone(sender.phone) ?? sender.phone}`,
    ]),
    '',
    `${sender.postalAddress}. If you'd rather not hear from me, reply "stop" or use ${unsubUrl}`,
  ].join('\n');
}

export function senderProblems(s: Partial<Sender> | null): string[] {
  if (!s) return ['profile/sender.json is missing'];
  const p: string[] = [];
  for (const k of ['fromName', 'fromEmail', 'replyTo', 'company', 'website', 'phone', 'postalAddress', 'unsubBase'] as const) {
    if (!String(s[k] ?? '').trim()) p.push(`sender.${k} is empty`);
  }
  // A subdomain (hello.omniatherapies.com) keeps most of its sending reputation apart from the main domain;
  // the main domain carries patient mail, so cold mail never goes from it.
  const own = (s.website ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  const fromDomain = s.fromEmail?.trim().split('@')[1]?.toLowerCase();
  if (fromDomain && fromDomain === own)
    p.push(`sender.fromEmail is on ${fromDomain} itself; cold mail goes from an outreach subdomain (hello.${fromDomain})`);
  return p;
}

// ------------------------------------------------------------ Resend

/** `key` is unique across every client and every tool sharing the Resend account: Resend drops a repeated key. */
export type Outgoing = { key: string; to: string; subject: string; text: string; unsubUrl: string; inReplyTo?: string | null };

export async function sendViaResend(apiKey: string, sender: Pick<Sender, 'fromName' | 'fromEmail' | 'replyTo' | 'listUnsubscribeHeader'>, m: Outgoing): Promise<string> {
  const res = await request('https://api.resend.com/emails', {
    retries: 1,
    headers: { authorization: `Bearer ${apiKey}`, 'Idempotency-Key': `referpipe-${m.key}` },
    body: {
      from: `${sender.fromName} <${sender.fromEmail}>`, to: [m.to], reply_to: sender.replyTo, subject: m.subject, text: m.text,
      headers: {
        ...(sender.listUnsubscribeHeader ? {
          'List-Unsubscribe': `<${m.unsubUrl}>, <mailto:${sender.replyTo}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        } : {}),
        ...(m.inReplyTo ? { 'In-Reply-To': m.inReplyTo, References: m.inReplyTo } : {}),
      },
    },
  });
  const body = await res.json() as { id?: string };
  if (!body.id) throw new Error('Resend returned no id');
  return body.id;
}

/** delivered, bounced, complained, opened, … (Resend's last_event). */
export async function resendStatus(apiKey: string, providerId: string): Promise<string | null> {
  const res = await request(`https://api.resend.com/emails/${providerId}`, { headers: { authorization: `Bearer ${apiKey}` }, retries: 1 });
  return ((await res.json()) as { last_event?: string }).last_event ?? null;
}

/** Addresses Resend's contacts mark unsubscribed: the one-click page writes them there. */
export async function resendUnsubscribed(apiKey: string): Promise<string[]> {
  const out: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
    const res = await request(`https://api.resend.com/contacts?${q}`, { headers: { authorization: `Bearer ${apiKey}` }, retries: 1 });
    const body = await res.json() as { data?: { id: string; email: string; unsubscribed?: boolean }[]; has_more?: boolean };
    const data = body.data ?? [];
    out.push(...data.filter((c) => c.unsubscribed).map((c) => c.email.toLowerCase()));
    if (!body.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}
