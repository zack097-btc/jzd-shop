#!/usr/bin/env python3
"""Rebuild the embedded labor catalog in index.html from a CSV export.

    python seed_from_csv.py shop_manager_labor_catalog.csv

The catalog is data, so it lives in a <script type="application/json"> block in
index.html rather than in a file of its own. That is deliberate: the app runs
from a file:// page and inside the desktop shell, and a browser will not fetch
a sibling JSON file from file:// — a separate catalog.json would work in the
installed app and silently fail everywhere else, including in the tests.

This script replaces that block and nothing else. It refuses rather than
guesses: a missing column, a duplicate Service ID or a row that cannot be
priced stops the run with the offending row named. Losing catalogue rows
quietly is the exact failure this whole program was rebuilt to prevent.
"""
import csv
import io
import json
import os
import sys

COLUMNS = ['Service ID', 'Section', 'Category', 'Vehicle Scope', 'Service',
           'Billing Method', 'Labor Hours', 'Fixed/Menu Price', 'Default Charge',
           'Charge @ $100', 'Charge @ $125', 'Parts / Fluids Policy', 'Notes',
           'Confidence', 'VIN/Guide Verify', 'Source']

START = '<script type="application/json" id="seed-catalog">['
END = ']</script>'


def number(raw):
    raw = (raw or '').strip().replace('$', '').replace(',', '')
    if raw == '':
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return int(value) if value == int(value) else value


def read_rows(path):
    rows = list(csv.DictReader(io.open(path, encoding='utf-8-sig')))
    if not rows:
        sys.exit('%s has no rows.' % path)
    missing = [c for c in COLUMNS if c not in rows[0]]
    if missing:
        sys.exit('%s is missing column(s): %s' % (path, ', '.join(missing)))

    seen, out = {}, []
    for n, r in enumerate(rows, start=2):          # line 1 is the header
        sid = r['Service ID'].strip()
        if not sid:
            sys.exit('Line %d has no Service ID. Service ID is the stable key and cannot be blank.' % n)
        if sid in seen:
            sys.exit('Service ID %s appears twice, on lines %d and %d.' % (sid, seen[sid], n))
        seen[sid] = n

        method = r['Billing Method'].strip()
        if method not in ('Hourly', 'Fixed'):
            sys.exit('Line %d (%s): Billing Method is "%s" — it must be Hourly or Fixed.' % (n, sid, method))

        row = {
            'id': sid,
            'sec': r['Section'].strip(),
            'cat': r['Category'].strip(),
            'scope': r['Vehicle Scope'].strip(),
            'svc': r['Service'].strip(),
            'bill': 'F' if method == 'Fixed' else 'H',
            'hrs': number(r['Labor Hours']),
            'fix': number(r['Fixed/Menu Price']),
            'pol': r['Parts / Fluids Policy'].strip(),
            'note': r['Notes'].strip(),
            'conf': r['Confidence'].strip(),
            'ver': 1 if r['VIN/Guide Verify'].strip().upper() == 'YES' else 0,
            'src': r['Source'].strip(),
            'ref': [number(r['Default Charge']), number(r['Charge @ $100']), number(r['Charge @ $125'])],
        }
        # An hourly row with no hours, or a fixed row with no price, cannot be
        # charged for. Better to stop here than to ship a job that quotes $0.
        if row['bill'] == 'H' and row['hrs'] is None:
            sys.exit('Line %d (%s): an Hourly row needs Labor Hours.' % (n, sid))
        if row['bill'] == 'F' and row['fix'] is None:
            sys.exit('Line %d (%s): a Fixed row needs a Fixed/Menu Price.' % (n, sid))
        out.append(row)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    csv_path = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    page = os.path.join(here, 'index.html')

    rows = read_rows(csv_path)
    html = io.open(page, encoding='utf-8').read()
    start, end = html.find(START), html.find(END)
    if start < 0 or end < 0:
        sys.exit('Could not find the seed-catalog block in index.html.')

    body = ',\n'.join(json.dumps(r, ensure_ascii=True, separators=(',', ':')) for r in rows)
    html = html[:start + len(START)] + '\n' + body + '\n' + html[end:]
    io.open(page, 'w', encoding='utf-8', newline='\n').write(html)

    sections = {}
    for r in rows:
        sections[r['sec']] = sections.get(r['sec'], 0) + 1
    print('embedded %d jobs from %s' % (len(rows), os.path.basename(csv_path)))
    for name in sorted(sections):
        print('  %-16s %d' % (name, sections[name]))
    print('  %-16s %d' % ('flagged VERIFY', sum(r['ver'] for r in rows)))
    print('Now run: python build.py && node testsave.cjs && node testvin.cjs')


if __name__ == '__main__':
    main()
