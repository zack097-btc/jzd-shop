# JZD Inc. — Shop Manager

A browser-based shop management app for the mechanic side of JZD Inc. — separate
from JZAK Cuts. Track customers, their vehicles, and work orders, and print
clean invoices and estimates. Runs in any browser, saves in that browser, and
lives in its own GitHub repo/URL.

**Open it here: https://zack097-btc.github.io/jzd-shop/** — bookmark it, or
install it (see below) so it opens like a regular program.

## What it does (v2)

- **Customers** — name, phone, email, address, notes.
- **Vehicles** — year / make / model, VIN, plate, color, mileage, notes, linked
  to a customer.
- **Service history** — open any vehicle and every work order ever written for
  it is right there, newest first, with status and totals.
- **Work orders** — pick a customer + vehicle (or create either on the fly),
  record the complaint, add labor lines (hours × rate) and parts lines
  (qty × price), set status (Estimate → Approved → In Progress → Completed →
  Invoiced → Paid), mileage in/out, and tech notes.
- **Labor & parts catalog** — save the jobs and parts you sell again and again
  (with your standard hours, rates and prices), then drop them into any work
  order from a menu instead of retyping them. Any work order's lines can be
  saved back to the catalog in one click.
- **Invoices & estimates** — one click to print (or Save as PDF) a clean
  document with your JZD Inc. header, customer, vehicle, line items, tax, and
  totals. Auto-incrementing invoice numbers.
- **Settings** — shop name/tagline/address/phone/email, default labor rate,
  sales-tax rate, tax-on-labor toggle (default: parts only), invoice
  footer/terms, and starting invoice number.
- **Backup** — Export all data to a `.json` file and Import it back (to back up
  or move to another computer).
- **Installable app (PWA)** — Chrome/Edge offer to install it from the address
  bar. The installed copy opens in its own window, works with no internet, and
  keeps all your data.

## Installing it like a program

Open https://zack097-btc.github.io/jzd-shop/ in Chrome or Edge and click the
install icon in the address bar (or menu ▸ *Install JZD Shop*). It appears in
the Start menu like any other app and works offline from then on.

## Notes

Data is stored in the browser (or installed app) it's used on — use **Export
backup** regularly, and use it to move your records to another computer. This
is light bookkeeping — work orders and invoices — not full accounting or
payments processing. Ask any time to add payment tracking, inventory counts, or
emailing invoices.

The test suite is `testshop.cjs` — it drives the real app in a headless browser
through customer → vehicle → work order → totals → invoice → backup → reload
and checks every step. `node testshop.cjs` with any static server on :8098.
