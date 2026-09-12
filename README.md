# JZD Inc. — Shop Manager

A Windows program for the mechanic side of JZD Inc. — separate from JZAK Cuts.
Customers, their vehicles, work orders, invoices, and a labor catalog that knows
what the car in the bay actually is.

**[Download the installer](https://github.com/zack097-btc/jzd-shop/releases/latest)**
— run it, no administrator rights needed. It is not code-signed yet, so the
first run shows *Windows protected your PC*: click **More info ▸ Run anyway**.

Your shop book is a real file on your own machine. No account, no internet, no
subscription. Settings ▸ **Where is my data?** shows the folder.

> The old browser version at `zack097-btc.github.io/jzd-shop` is retired. It
> kept everything in browser storage, which is separate for every address it
> was opened from — two hours of catalog work went into a copy nobody was
> reading back. That is the whole reason this is a program now.

## What it does

- **VIN in, vehicle out** — type, paste or scan a VIN and the vehicle
  identifies itself through the free NHTSA vPIC service: year, make, model,
  series, engine, cylinders, displacement, fuel, drive type, GVWR class. The
  decode is kept, so the second time that car comes in it costs nothing and
  works offline. No VIN, or NHTSA down? Type the year/make/model and carry on —
  nothing here needs the internet.
- **A labor catalog that matches the car** — 245 curated jobs across Market
  Menu, General Labor, Truck & Fleet and BMW M3. Open **+ Add job** on a work
  order and the list is already sorted by how well each job fits *this*
  vehicle: an E46 gets S54 jobs and never E9x ones, a 3/4-ton diesel 4WD gets
  the heavy-duty rows and not the half-ton ones, and the everyday tire and oil
  work stays reachable on every vehicle.
- **Search the way a service writer talks** — *LOF*, *plugs*, *serp belt*,
  *cab filter*, *thrust arm*, *R&R*, or a Service ID straight off the sheet.
- **Pricing that does not embarrass you** — hourly jobs bill hours × your shop
  rate. Menu jobs (tire mounting, alignments, LOF packages, BMW oil services)
  bill their menu price and are **never** multiplied by the door rate. Change
  your rate and open estimates follow it; invoices you have already issued do
  not move.
- **Every number says where it came from** — each labor line carries a badge:
  `SHOP SEED`, `SHOP OVERRIDE`, `MANUAL`, `NHTSA VEHICLE ID`. Jobs whose time
  depends on the exact vehicle are flagged **VERIFY** and gathered into a
  warning above the total, so nobody quotes a big job off a catalog time
  without checking it first.
- **Overrides, on the record** — any catalog time or menu price can be
  overridden, but not anonymously: it asks who and why (and a manager PIN if
  you set one) and keeps the history in Settings. The catalog row itself is
  never edited, so you can always see what it started as and undo back to it.
- **Estimate → approval → repair order → invoice → paid** — the whole ticket,
  in one screen. Statuses are Estimate, Awaiting Approval, Approved, In
  Progress, Waiting on Parts, Completed, Invoiced, Paid / Closed, Declined and
  Cancelled, and every change is dated and kept.
- **Parts with cost and price, not just price** — enter what a part cost you
  and the default markup suggests a selling price you can type straight over.
  Both numbers are kept, because the difference is your margin. Cost, markup
  and vendor never appear on a customer document.
- **Sublet, shop fees and discounts** — set fees up once in Settings (flat or a
  percentage of labor, parts, or both, taxable or not) and drop them onto a
  ticket. Nothing is ever added to a ticket by itself.
- **Tax you configure** — labor, parts and fees are each taxable or not
  according to what your accountant told you, with a per-line override. This
  program does arithmetic, not law.
- **Customer authorization that protects you** — record who approved what, how
  (in person, phone, text, email) and for how much. Add work after that and the
  ticket says **ADDITIONAL AUTHORIZATION REQUIRED** the moment the total passes
  what they agreed to, rather than assuming the answer is still yes.
- **Payments** — cash, card, check, bank transfer or other, partial or in full,
  with the balance always on screen. No card numbers are stored, ever, and
  there is no processor and no monthly fee.
- **Three documents** — a customer estimate with a signature line, a shop-copy
  repair order carrying the internal notes and verification warnings and no
  line pricing, and a customer invoice. All print on US Letter and save as PDF
  through Windows, with no subscription and no internet.
- **An open-work dashboard** — what is awaiting approval, approved, on a lift,
  stuck on a part, finished, or invoiced and unpaid, with totals and balances.
- **Backup** — Export/Import a `.json`, plus **Restore from backup…**: the app
  keeps the last 60 copies of your book automatically, one taken before every
  single change.

## The catalog is your catalog

The 245 jobs are **this shop's own curated seed data**. They are not Mitchell,
ALLDATA, MOTOR, or an OEM labor guide, and nothing in the program will ever
label them as one. Treat a flagged job as a starting point and check it against
an approved labor guide for the exact VIN before you quote it.

The code has a provider boundary ready for a licensed guide — MOTOR Data as a
Service / TruSpeed Repair first, with adapter seams for Mitchell ProDemand and
ALLDATA. None is connected, none is required, and the app is complete without
one. When a subscription exists, its credentials go in this machine's settings
— never in this repository — and its exact times take priority over the
catalog.

To load a new catalog export:

```bash
python seed_from_csv.py shop_manager_labor_catalog.csv
```

It refuses rather than guesses: a missing column, a duplicate Service ID or a
row that cannot be priced stops the run and names the row. Service ID is the
stable key.

## How your data is kept

The thing that went wrong before cannot happen the same way twice:

- Every write copies the current book into `backups/` first, writes to a temp
  file, flushes it to the physical disk, renames it over the real one, then
  **reads it back and compares**. A write that did not land is an error, never
  a success.
- A book that exists but cannot be read is an **emergency, not an empty shop**:
  saving stops, the screen says so, and restore is offered. It is never written
  over.
- The save indicator never lies. It says **NOT SAVING** when saving is blocked
  and **SAVE FAILED** when a write did not land.

## Working on it

```bash
python build.py        # stage into desktop/dist; refuses on version drift
node testsave.cjs      # persistence suite
node testvin.cjs       # VIN, matching, pricing, overrides, provenance
node testflow.cjs      # estimate to paid invoice, and old books still opening
cd desktop/src-tauri && cargo test    # the storage layer
```

`index.html` is the whole app in one file and is the source; `build.py` stages
it into the desktop shell and refuses to run unless `index.html`,
`tauri.conf.json` and `Cargo.toml` agree on the version. Both browser suites
stub the network, so no release ever depends on a third party being up.

Once an invoice is finalized it carries its own copy of the labor rate and the
tax rules it was billed under, so changing either afterwards cannot move a
document a customer already has. Numbers, once issued, are never reused.

Tag a version (`git tag v2.3.0 && git push origin v2.3.0`) and CI runs all four
suites, then builds and publishes the installer.
