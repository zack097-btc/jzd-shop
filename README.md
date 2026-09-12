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
- **Vehicle check-in** — mileage, fuel, keys and key tag, where the car is
  parked, what the customer reported, and a **pre-existing damage record**:
  area, damage type, severity and note, stamped with who wrote it and when,
  before anybody touches the vehicle. Prints as a condition report with
  signature lines.
- **A real multipoint inspection** — 129 checks across 18 groups, and it stores
  the *number*, not just a colour: tread in 32nds per wheel, pad thickness
  inner and outer per corner, rotor thickness against its minimum spec, brake
  fluid moisture percentage, coolant freeze point, battery volts and measured
  against rated CCA, oil life. Tyres and brakes are entered as a matrix, so four
  wheels is four rows rather than four screens. **Mark remaining Good** handles
  everything the technician was happy with in one tap.
- **Measurements that suggest, never decide** — set your own thresholds in
  Settings and a reading proposes a condition on an untouched item. The
  technician is standing at the car and can always overrule it.
- **Findings become work** — an inspection finding turns into a recommendation,
  and a recommendation turns into a line on the estimate through the same
  catalog and the same pricing engine as everything else.
- **Declined work never disappears** — what a customer said no to is kept
  against the *vehicle* with the date, the mileage and the amount, and it
  surfaces automatically on their next visit under **PREVIOUSLY DECLINED**.
- **Jobs and parts have their own states** — a job can be Waiting Parts while
  the ticket is In Progress; a part is Needed, Ordered, Backordered, Received or
  Installed, and anything not yet in the building raises **WAITING ON PARTS**
  naming the parts.
- **A shop board** — every open ticket by what is stopping it, with technician,
  inspection state, jobs done out of total, missing parts and balance. Search
  across customer, VIN (full or partial), plate, RO or invoice number.
- **A shop-floor view** — the same ticket with the money taken out, for a
  screen in the bay. It is a view, not a login: it hides prices as a
  convenience and does not pretend to be security.
- **A customer inspection report** — what needs attention now, what to keep an
  eye on, and everything checked and sound, with the measurements. Statuses
  print with words as well as colour so a grayscale copy still reads.
- **The shop floor, live** — one board with every car in the building in the
  column it is actually in: checked in, diagnosis, awaiting approval, waiting on
  parts, ready to work, in progress, quality control, ready for pickup. Each card
  says who has it, which bay, how many sold hours, how many jobs are done,
  whether the parts are here, and anything holding it up.
- **Bays, dispatch and a queue for each technician** — a bay knows which car is
  in it and asks before a second one goes in. Dispatch shows who is on the clock,
  who has work ready and who is waiting; each technician gets NOW / NEXT /
  WAITING / COMPLETED with the parts readiness on every job.
- **Clock time that never touches sold time** — START, PAUSE, RESUME and
  COMPLETE record real time sessions. Sold hours stay exactly as the ticket
  says. Efficiency is sold hours completed divided by the clock hours on those
  same jobs, and a timer left running is called out rather than quietly counted.
- **Quality control and road tests** — a finished job can go to a checklist
  QC; a failure names the item and sends the job back to work with its history
  intact. Pre- and post-repair road tests and wheel torque (spec entered by
  hand, or SPEC UNKNOWN / VERIFY — never guessed) are kept with the job.
- **Diagnosis as a record, not a code** — concern, verification, observations,
  tests, measurements with their spec and where it came from, trouble codes as
  the scan tool reported them, root cause, recommended repair, verification.
  A code on its own never becomes a diagnosis.
- **Comebacks and the vehicle's technical history** — link a return visit to
  the earlier job and part without changing that RO or deciding whose fault it
  was. The vehicle page shows installed parts, a searchable timeline, repeated
  concerns with their mileages, and maintenance status from the shop's own
  intervals — UNKNOWN when there is no record, never assumed.
- **Parts you actually have** — a catalog with stock, bins, units and reorder
  levels, or non-stock items for a one-off special order. **On hand** is the
  shelf, **committed** is what live tickets have claimed, **available** is the
  difference, and stock only physically moves when a part is received, fitted,
  returned or counted — each leaving a movement behind that says why.
- **Vendors and purchase orders** — order a part straight from the ticket and it
  joins that vendor's open PO rather than starting another one. Receive all of
  it, or part of it at a price that differs from the quote; the remainder stays
  backordered and the ticket keeps saying **WAITING ON PARTS** until it arrives,
  then says **PARTS READY**.
- **Markup that matches how a shop prices** — a tier table by cost, because a
  $6 clip and a $600 compressor cannot carry the same percentage. Every price
  says where it came from: catalog, part markup, tier, or typed by hand.
- **Cores, and both kinds of return** — a core charge is tracked apart from the
  part cost, through due, removed, returned and credited, with the credit
  expected and the credit actually received. A part can go back to your shelf or
  back to the supplier, and each leaves its own record.
- **Cost history** — what a part has cost you over time, so a 30% rise is
  something you notice rather than absorb.
- **A schedule, and a front office** — book a customer and a vehicle onto a day
  and a time with the work they asked for, in day or week view, with the hours
  already booked shown against what the shop can actually do. **Arrive / check
  in** hands the appointment straight to the existing check-in with the
  customer, vehicle, concern, technician and requested work already filled in —
  there is no second check-in screen.
- **Customers who only exist once** — a customer who rings back is flagged as a
  probable duplicate by phone, email or name before a second record is made,
  and a VIN already in the book is caught before a car gets two histories.
  Nothing is ever merged automatically.
- **Work they said no to, offered again** — booking a known vehicle puts its
  previously declined work on screen with the date, the mileage and the amount,
  ready to add to the appointment. Nobody has to remember to go looking.
- **Businesses and fleets** — a company name and a contact, as many vehicles as
  they like, and a unit number on each one.
- **One search box** — name, business, phone however it is punctuated, email,
  full or partial VIN, plate, unit number, RO or invoice number.
- **Photographs, where they belong** — on a damage entry, on an inspection
  finding, on a vehicle. Each one is marked either for the customer or internal
  to the shop, takes a caption, and appears on the customer's report only when
  you say so. Tyres and brakes have a camera button on the row itself, because
  that is where the photographs actually get taken.
- **Backup** — Export/Import one file that carries the whole book **and every
  photograph**, so a restore comes back complete. Plus **Restore from
  backup…**: the app keeps the last 60 copies of your book automatically, one
  taken before every single change.

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
node testshop.cjs      # check-in, inspection, recommendations, parts, history
node testphoto.cjs     # photographs, visibility, and a real backup round trip
node testfront.cjs     # customers, duplicates, appointments, arrival, search
node testparts.cjs     # stock, vendors, purchase orders, receiving, cores
node testfloor.cjs     # bays, job clock, efficiency, QC, diagnosis, comebacks, maintenance
cd desktop/src-tauri && cargo test    # the storage layer
```

`index.html` is the whole app in one file and is the source; `build.py` stages
it into the desktop shell and refuses to run unless `index.html`,
`tauri.conf.json` and `Cargo.toml` agree on the version. Both browser suites
stub the network, so no release ever depends on a third party being up.

Once an invoice is finalized it carries its own copy of the labor rate and the
tax rules it was billed under, so changing either afterwards cannot move a
document a customer already has. Numbers, once issued, are never reused.

A completed inspection keeps its own copy of the template it was filled in
against, so adding a check next month does not leave a hole in every inspection
already handed to a customer.

Photographs are files in the app's own `attachments/` folder, never bytes in
the book: a book carrying its own photographs would be rewritten whole on every
keystroke and copied into sixty backups. The book keeps a small record and a
thumbnail; a backup is the one place the two travel together.

Parts carry two numbers that must never be confused: what they cost you and
what they sold for. The first never appears on anything a customer sees, and
changing either today cannot reach backwards into an invoice already issued.

Sold hours and clock hours are two numbers that must never be confused either:
what the customer was charged for, and what the job actually took. Timers write
only time sessions; nothing on the floor can change a labor line's hours or an
invoice.

Tag a version (`git tag v2.7.0 && git push origin v2.7.0`) and CI runs all nine
suites, then builds and publishes the installer.
