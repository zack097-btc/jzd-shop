# JZD Inc. — Shop Manager

A simple, browser-based shop management app for the mechanic side of JZD Inc. — **separate from JZAK Cuts**. Track customers, their vehicles, and work orders, and print clean invoices and estimates. Runs in any browser, saves in that browser, and lives in its own GitHub repo/URL.

## What it does (v1)

- **Customers** — name, phone, email, address, notes.
- **Vehicles** — year / make / model, VIN, plate, color, mileage, notes, linked to a customer.
- **Work orders** — pick a customer + vehicle (or create on the fly), record the complaint/work requested, add **labor lines** (hours × rate) and **parts lines** (qty × price), set status (Estimate → Approved → In Progress → Completed → Invoiced → Paid), mileage in/out, and tech notes.
- **Invoices & estimates** — one click to print (or Save as PDF) a clean document with your JZD Inc. header, customer, vehicle, line items, tax, and totals. Auto-incrementing invoice numbers.
- **Settings** — shop name/tagline/address/phone/email, default labor rate, sales-tax rate, tax-on-labor toggle (default: parts only), invoice footer/terms, and starting invoice number.
- **Backup** — Export all data to a `.json` file and Import it back (to back up or move to another computer).

## Run it on any computer

1. Create a **new** GitHub repo named `jzd-shop`.
2. Upload `index.html`.
3. Settings → Pages → Deploy from branch → `main` / `root`.
4. Open **https://zack097-btc.github.io/jzd-shop/** in any browser and bookmark it.

## Notes

Data is stored in the browser it's used on (localStorage), so use **Export backup** regularly. This is light bookkeeping — work orders and invoices — not full accounting or payments processing. Ask any time to add payment tracking, an inventory/parts catalog, service history per vehicle, or emailing invoices.
