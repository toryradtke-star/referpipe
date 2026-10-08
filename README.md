# referpipe

Finds the local businesses that could send a clinic or gym its patients or members (chiropractors, trainers, running stores, youth hockey, independent doctors), reads their sites, judges the fit with quotes from those sites, and drafts a short introduction from the owner. **Nothing sends until a person types `send`.**

It started with [Omnia Wellness & Recovery](https://omniatherapies.com), a physical therapy clinic in Superior, WI, and is built to take more clients. It shares its skeleton with [leadpipe](https://github.com/toryradtke-star/leadpipe) (Webcraft's own prospecting) but is a separate tool with separate data: TypeScript on Node 22, no dependencies, one SQLite file per client.

```
poll ──▶ enrich ──▶ screen + dedupe ──▶ judge ──▶ draft ──▶ queue ──▶ send (only on "--confirm send")
Places    their site,  chains, health      Claude:    intro +    warmup    Resend, from the client's
+ OSM     published    systems, the        fit, with  2 follow-  cap       outreach subdomain
          emails       client itself       quotes     ups                  ▲
                                                                            sync: bounces, unsubscribes
```

## Why it's built this way

- **Every claim is quoted, not generated.** The judge must quote the partner's own site for why the two fit, and code drops any quote that isn't really there. A lead with no real quote can't be hot or warm.
- **Healthcare rules are code.** Nothing of value may be offered for a referral (Anti-Kickback Statute and state equivalents): the writer is told so, and code rejects gift cards, fees, "rewards", free lunches and the like. Code also rejects any email asking for patient details.
- **Hospital systems and competitors are out.** St. Luke's, Essentia, Aspirus and the like refer internally; a chiropractor marketing its own "rehab" is a competitor. The screen catches the names; the judge's rubric catches the rest.
- **The legally required parts are code, not model output.** Claude writes the middle of each email. Code adds the greeting, the clinician's signature (with fax, for referrals), the postal address and the opt-out (CAN-SPAM).
- **Mail goes from an outreach subdomain**, never the client's main domain; plain text, no tracking, a 5 → 12 → 25 per day warmup.
- **A send can't double, and a typo can't send.** `send` refuses unknown flags; Resend idempotency keys are unique per client (`referpipe-<client>-<id>`), so they never collide with leadpipe's in a shared Resend account.
- **No double contact.** The outbox warns when Webcraft's own outreach (leadpipe) already wrote to the same address or domain.

## Clients

Each client is a folder, `clients/<name>/`:

| File | What it holds |
|---|---|
| `targets.json` | Partner categories (Places query, OSM tags) and towns |
| `profile/offer.md` | Who is writing and what the client offers: only facts from its own site |
| `profile/rubric.md` | Who is a good partner, who is a competitor, what to skip |
| `profile/rules.json` | Extra chains and health systems to rule out, and the client's own names |
| `profile/sender.json` | From name and address, reply-to, postal address, signature lines |
| `data/referpipe.db` | The store (gitignored) |

`referpipe init --client <name>` creates the starter files. With one client, `--client` is optional.

Real clients are gitignored: only `clients/example/` (a fictional clinic) is in the repo. Copy it to start a new one.

## Commands

```sh
./bin/referpipe.ts poll --town Superior,Duluth --slice 24   # Places + OSM searches, least recently run first
./bin/referpipe.ts enrich --limit 100       # read their sites, collect published emails (robots.txt obeyed)
./bin/referpipe.ts screen                   # named rule-outs, then dedupe
./bin/referpipe.ts judge --limit 40         # fit, tier, and quotes from their site
./bin/referpipe.ts report                   # clients/<name>/out/partners-<date>.md
./bin/referpipe.ts draft --limit 10         # introduction + two follow-ups per hot/warm partner
./bin/referpipe.ts queue && ./bin/referpipe.ts outbox
./bin/referpipe.ts send --dry-run           # the exact text that would go out
./bin/referpipe.ts send --test-to you@example.com --confirm send
./bin/referpipe.ts send --confirm send      # the gate
./bin/referpipe.ts sync | sent | replied <email> [--stop] | stats | export-csv
npm test
```

Secrets come from the environment, then `clients/<name>/profile/secrets.env`, then a shared file (`REFERPIPE_SHARED_SECRETS`, default leadpipe's), so one Google key and one Resend account serve every client.
