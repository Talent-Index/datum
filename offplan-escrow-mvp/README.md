# Off-plan escrow — working MVP

Buyer deposits are held until construction evidence passes verification. Two of
three independent attesters release each milestone. If the developer walks away,
whatever hasn't been released comes back pro rata.

Built for PS01. The escrow is the business; the evidence pipeline is how you get
in the door.

## Run it

```bash
./run.sh
```

Installs into a local venv, fetches `solc`, runs both test suites, then serves
the console on <http://localhost:8000>. No network calls, no faucet, no wallet —
an in-process EVM holds the live project.

Tests only: `./run.sh test`

## Demo script — three minutes

0. **Check the public record.** Pick *Kilimani Heights Ltd* → deregistered by
   the NCA with a winding-up notice against it, verdict *do not proceed*, before
   a single photograph is looked at.
1. **Deposit.** `0722114050`, KES 500,000. The figures update: KES 500,000 in,
   all of it protected, nothing to the developer.
2. **Submit fraud first.** Pick *Photos taken 1.5 km away* → rejected, with the
   distance named. Then *Photos with location data stripped* → rejected. No
   funds move on either.
3. **Submit genuine progress.** Accepted. One of two signatures recorded.
4. **Surveyor confirms.** Milestone 1 fills on the register, 20% releases, the
   evidence hash is stamped under the segment.
5. **Add a second buyer mid-build**, then run milestone 2. Both buyers show 40%
   released against their own deposit — the late joiner catches up correctly.
6. **Try recycling milestone 1's photos.** Rejected, naming the milestone they
   were already used for.
7. **Declare stalled, refund everyone.** Equal pro-rata shares regardless of
   claim order.

Step 2 and step 7 are what judges and lenders actually care about.

## Layout

```
contracts/PropertyEscrow.sol   escrow, attestation, refunds
contracts/MockKES.sol          KES-pegged test token (2 decimals)
evidence/verifier.py           EXIF geofence, recency, perceptual hash, stage
evidence/fixtures.py           synthetic geotagged site photos
datasources/http.py            cached, rate-limited, offline-capable fetch
datasources/osm.py             Nominatim geocoding, Overpass footprints
datasources/registers.py       NCA, Kenya Gazette, EBK adapters
datasources/corroborate.py     combines them into a site verdict
datasources/warm.py            cache warming CLI
tests/test_escrow.py           22 assertions on the money paths
tests/test_evidence.py         17 assertions on the fraud paths
tests/test_data.py             24 assertions on the public data layer
app.py                         FastAPI + in-process EVM
web/index.html                 the console
scripts/deploy_fuji.py         same contracts, on testnet
```

## Public data

Photographs prove what the camera saw. They do not prove the site is where the
developer says it is, or that the company behind it is still trading. Three
public sources close that gap, and the console runs them as a second check
beside the photo verdict.

**OpenStreetMap**, via Nominatim and Overpass. No key, no registration. Used to
resolve a site name to coordinates independently of the developer's claim, and
to count buildings and land use within the geofence. Coverage in peri-urban
Kenya lags reality, so presence of a mapped building is evidence and absence is
unknown, never proof. ODbL — credit OpenStreetMap contributors wherever you
display it.

**NCA register of contractors.** Section 25 of the NCA Act lets the Authority
deregister contractors who default on annual licence renewal, and a
deregistered contractor cannot re-register under a different name. That makes
deregistration a permanent, checkable signal. The portal search is public;
bulk export is not, so ask.

**Kenya Gazette.** Winding-up petitions, insolvency notices and liquidator
appointments. Free, public, and the strongest negative signal available.

**EBK project registration**, launched December 2025. A project reference
issued before drawings go to the county. A live site with no reference is a
real flag, and almost nobody is checking it yet.

Each register has a CSV-backed adapter under `fixtures/registers/`, so the
pipeline is written against a stable interface today and the acquisition
method can change without touching anything above it.

### Caching and offline mode

Every fetch goes through `datasources/http.py`, which caches to disk, throttles
per host, and sends a contact User-Agent — Nominatim's usage policy requires
one and rejects you without it. Default is offline: the app and the tests
replay the committed cache and never touch the network, so a demo cannot fail
on someone else's uptime.

```bash
# placeholder fixtures, shaped like the real APIs, so it runs before you fetch
python3 -m datasources.warm --seed

# real data, then commit the cache
DATA_OFFLINE=0 DATA_CONTACT="you@example.com" python3 -m datasources.warm \
  --site "Your Project, Suburb, Nairobi" --lat -1.29210 --lon 36.78270

python3 -m datasources.warm --stats
```

The committed cache ships with seeded placeholders, not real captures. Warm it
against your own site before showing anyone.

### Before you scrape anything

Terms of use are a real constraint on each portal, and director details are
personal data under the Data Protection Act 2019. Register with the ODPC and
document a lawful basis before holding this at scale. A week now, a dead deal
later.

## Design decisions worth defending

**Denominated in KES, never in a native token.** A 24-month build funded in a
volatile asset is a currency bet wrapped around a house. The escrow holds a
KES-pegged token; in production that token mirrors a segregated bank escrow
account and the chain is the claim ledger, not the custodian.

**Cumulative release, not flat slices.** Off-plan buyers join throughout
construction. `total * percent / 100` per milestone silently over- or
under-releases once the pool moves. Release targets a cumulative percentage of
the current pool and pays the difference. A buyer joining at 60% completion has
60% of their money released at the next event, which is correct.

**Refunds pay from a snapshot.** Computing pro rata against the live balance
lets the first claimant take a full refund and leaves everyone else short. The
pool is snapshotted at the moment the project is declared stalled.

**Two of three, and the platform is only one of them.** Oracle, surveyor,
platform. Any two advance a milestone. If the platform could veto, the buyer
would just be trusting the platform, which is the problem this exists to solve.

**Buyers can escape a silent platform.** After 30 days without a deposit or a
release, anyone can declare the project stalled and open refunds. Without this
the escape hatch depends on the party you might need to escape from.

**Custodial, and say so.** Buyers log in with a phone number and never hold a
key. That is right for this market and it is the honest thing to tell a
regulator — custody is what makes the bank partnership and the licensing
question real.

## What's real and what's stubbed

Real: the contract and its money paths, the four evidence checks, the
deterministic bundle hash, the OSM and register clients, the corroboration
scoring, the whole loop end to end.

Stubbed: the shipped cache holds seeded placeholder responses rather than real
OSM captures, and the register CSVs hold four invented developers.
`StageClassifier.classify` reads a sidecar label — swap in a
fine-tuned ONNX classifier or a vision-language call, nothing else changes.
Deposits simulate an M-Pesa settlement rather than calling Daraja. Site photos
are generated with real EXIF rather than shot on site. Managed wallets are
local accounts, not Privy or a KMS.

Not started: IPFS pinning, permissioned L1 with bank and surveyor validators,
eERC confidential balances, KYC.

## Next three things

1. Replace the classifier stub with a real model and re-shoot the fixtures with
   photographs from one actual Nairobi site.
2. Wire Daraja sandbox behind the deposit endpoint. Create the pending payment
   row keyed on `CheckoutRequestID` before the push — `AccountReference` is
   capped at 12 characters and isn't returned in the callback.
3. Warm the cache against a real site and load the NCA register for Nairobi,
   Kiambu and Machakos. Cross-reference against site boards photographed on the
   corridors — an active site with no NCA registration is both a lead and the
   first row of the developer risk index.
4. Deploy to Fuji with three separate keys so the two-of-three is real rather
   than one account signing twice.

```bash
export DEPLOYER_KEY=0x...
python3 scripts/deploy_fuji.py
```
