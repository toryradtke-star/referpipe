/**
 * The deterministic screen: rule-outs that need no model.
 *
 * Same contract as jobpipe's: every rule is named, a ruled-out business
 * records every rule that fired, and the bias is one-way. A rule fires only on
 * plain evidence; anything that needs judgment passes to the judge, because a
 * business wrongly thrown away is never seen again.
 *
 * Flags are not rule-outs. They are facts the judge and the queue need:
 * `no-email` means the pitch has to go through a contact form or the phone.
 */
import type { Audit, Business, Screen } from './types.ts';
import { domainOf } from './normalize.ts';

export type Rules = {
  states: string[];
  /** Brands and franchises: they buy marketing from head office. */
  chains: RegExp;
  /** The client itself and its own locations, by name or domain (rules.json `clients`). */
  clients: RegExp;
  /** A domain shared by this many businesses or more is a franchise site. */
  sharedDomainLimit: number;
};

export const DEFAULT_CHAINS = [
  'anytime fitness', 'snap fitness', 'planet fitness', 'orangetheory', 'curves', 'crunch fitness', 'la fitness',
  'life time', 'lifetime fitness', 'gold\'?s gym', 'workout anytime', '9round', 'f45', 'pure barre',
  'great clips', 'supercuts', 'sport clips', 'fantastic sams', 'cost cutters', 'regis', 'smartstyle', 'ulta', 'hair ?cuttery',
  'aspen dental', 'gentle ?dental', 'heartland dental', 'smile direct', 'castle dental', 'healthpartners', 'park dental',
  'roto-?rooter', 'mr\\.? rooter', 'benjamin franklin plumbing', 'one hour heating', 'aire serv', 'service experts',
  'mr\\.? electric', 'mister sparky', 'servpro', 'servicemaster', 'stanley steemer', 'chem-?dry', 'molly maid', 'merry maids',
  'the joint chiropractic', 'athletico', 'ati physical therapy', 'twin cities orthopedics', 'tria orthopedic', 'essentia', 'sanford',
  'mayo clinic', 'allina', 'fairview', 'centracare', 'aspirus', 'marshfield', 'gundersen', 'jiffy lube', 'midas', 'meineke',
  'valvoline', 'firestone', 'goodyear', 'les schwab', 'tires plus', 'massage envy', 'hand & stone', 'european wax',
  'h&r block', 'jackson hewitt', 'state farm', 'edward jones', 'american family', 'farmers insurance', 'allstate',
];

export const DEFAULT_RULES: Rules = {
  states: ['MN', 'WI'],
  // CrossFit boxes are left out on purpose: affiliates are independently owned.
  chains: new RegExp(`\\b(${DEFAULT_CHAINS.join('|')})\\b`, 'i'),
  clients: /(?!)/,
  sharedDomainLimit: 3,
};

export type ScreenInput = {
  business: Business;
  audit: Audit | null;
  /** How many businesses in the store list the same website domain. */
  domainShares: number;
  suppressed: (emailOrDomain: string) => boolean;
};

export function screenBusiness({ business: b, audit, domainShares, suppressed }: ScreenInput, rules: Rules = DEFAULT_RULES): Screen {
  const reasons: string[] = [];
  const flags: string[] = [];
  const domain = domainOf(audit?.finalUrl ?? b.website);

  if (!rules.states.includes(b.state.toUpperCase())) reasons.push('outside-area');
  if (b.status && b.status !== 'OPERATIONAL') reasons.push('not-operating');
  if (b.brand || rules.chains.test(b.name)) reasons.push('chain');
  else if (domain && domainShares >= rules.sharedDomainLimit) reasons.push('chain');
  if (rules.clients.test(b.name) || (domain && rules.clients.test(domain))) reasons.push('client');

  const contacts = audit?.contacts ?? [];
  if (domain && suppressed(domain)) reasons.push('suppressed');
  else if (contacts.length && contacts.every((c) => suppressed(c.email))) reasons.push('suppressed');


  if (!contacts.some((c) => !suppressed(c.email))) flags.push('no-email');
  if (b.source === 'osm') flags.push('osm-only');

  return { businessId: b.id, verdict: reasons.length ? 'out' : 'pass', reasons, flags, screenedAt: new Date().toISOString() };
}
