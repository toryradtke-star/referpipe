/** Where a business was found. */
export type Source = 'places' | 'osm';

export type Business = {
  /** `${source}:${externalId}` */
  id: string;
  source: Source;
  externalId: string;
  name: string;
  /** The targets.json category key the search was for. */
  category: string;
  town: string;
  state: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** null when the source does not say. */
  hoursSet: boolean | null;
  /** Opening hours as the source writes them, one line per day (Places) or one OSM string. */
  hours: string[] | null;
  photoCount: number | null;
  mapsUrl: string | null;
  /** Places' businessStatus; OSM has none. */
  status: string | null;
  /** A brand the source names outright (OSM's brand tag). */
  brand: string | null;
  /** An email the source lists, e.g. OSM's email tag. */
  email: string | null;
  firstSeen: string;
  lastSeen: string;
};

export type Category = {
  key: string;
  label: string;
  /** Words for a Places text search: "<places> in <town>, <state>". */
  places: string;
  /** OSM tags as key=value. */
  osm: string[];
};

export type Town = { name: string; state: 'MN' | 'WI' };

export type Targets = { categories: Category[]; towns: Town[] };

/** One thing the audit learned, with an id the pitch can cite. */
export type Fact = {
  id: string;
  /** true is good for the business, false is a gap we can fix, null is neutral. */
  ok: boolean | null;
  text: string;
  value?: string | number | boolean | null;
  source: 'site' | 'psi' | 'places' | 'osm';
};

export type Contact = {
  email: string;
  sourceUrl: string;
  /** person: a named mailbox; generic: info@, office@ and friends. */
  kind: 'person' | 'generic';
  confidence: 'high' | 'medium';
};

export type Audit = {
  businessId: string;
  auditedAt: string;
  /** The URL the site finally answered at, after redirects. */
  finalUrl: string | null;
  siteStatus: 'none' | 'unknown' | 'ok' | 'down' | 'parked' | 'social-only' | 'blocked';
  psiMobile: number | null;
  cms: string | null;
  /** Readable text of the pages crawled, for the judge and the writer. Capped. */
  siteText: string | null;
  facts: Fact[];
  contacts: Contact[];
};

export type Screen = {
  businessId: string;
  verdict: 'pass' | 'out';
  reasons: string[];
  flags: string[];
  screenedAt: string;
};
