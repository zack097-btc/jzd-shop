#!/usr/bin/env python3
"""Jobs the shop found missing on its first real jobs (28 September 2026), with
the times the owner approved. They are SHOP SEED: the shop's own estimates,
marked VERIFY, never a MOTOR / Mitchell / ALLDATA / OEM time.

    python add_shop_jobs_20260928.py     (then: python seed_job_parts.py)

Adds the rows to the seed-catalog block in index.html after GEN-ELEC-010, and
refuses to add a Service ID that is already there.
"""
import io
import json
import re

SRC = "Shop seed time approved by the shop owner 2026-09-28 — not a licensed labor-guide time; verify model-specific guide"
POL = "Parts/fluids extra"

# id, category, service, hours, note
JOBS = [
    ("GEN-EMIS-001", "Emissions", "Secondary air injection pump replacement", 1.2, "Access varies (bumper/inner fender). Check the check/combi valve and hoses at the same time."),
    ("GEN-EMIS-002", "Emissions", "Secondary air check / combi valve replacement", 1.0, "Seized fasteners at the exhaust side may add time."),
    ("GEN-EMIS-003", "Emissions", "Secondary air system diagnosis", 1.0, "Pump, relay, valve, hoses and flow codes. Repair is separate."),
    ("GEN-EMIS-004", "Emissions", "EVAP smoke test / diagnosis", 1.0, "Repair is separate."),
    ("GEN-EMIS-005", "Emissions", "EVAP purge valve replacement", 0.6, ""),
    ("GEN-ELEC-011", "Electrical", "Connector / pigtail replacement — per connector", 0.8, "Cut in, solder and seal each wire. Several connectors: per connector."),
    ("GEN-ELEC-012", "Electrical", "Wiring harness repair — first hour", 1.0, "Bill additional time as used; note the circuits repaired."),
    ("GEN-ELEC-013", "Electrical", "Battery cable / terminal end replacement", 0.5, ""),
    ("GEN-ELEC-014", "Electrical", "Ground strap / ground circuit repair", 0.5, ""),
    ("GEN-ELEC-015", "Electrical", "Crankshaft position sensor replacement", 1.0, "Location varies widely by engine; verify."),
    ("GEN-ELEC-016", "Electrical", "Camshaft position sensor replacement", 0.5, ""),
    ("GEN-ELEC-017", "Electrical", "Mass airflow (MAF) sensor replacement", 0.3, ""),
    ("GEN-ELEC-018", "Electrical", "Door lock actuator replacement — one door", 1.5, ""),
    ("GEN-ELEC-019", "Electrical", "Power window switch replacement", 0.5, ""),
    ("GEN-ELEC-020", "Electrical", "Headlamp assembly replacement — one", 1.0, "Some vehicles need the bumper cover off; verify. Aim after."),
    ("GEN-ELEC-021", "Electrical", "Tail lamp socket / pigtail repair", 0.5, ""),
    ("GEN-ELEC-022", "Electrical", "Horn replacement", 0.5, ""),
    ("GEN-ELEC-023", "Electrical", "Blower motor resistor / final stage replacement", 0.5, ""),
    ("GEN-ELEC-024", "Electrical", "Ignition switch / lock cylinder replacement", 1.5, "Immobilizer/key programming may be separate."),
]


def main():
    path = 'index.html'
    s = io.open(path, encoding='utf-8').read()
    block = re.search(r'<script type="application/json" id="seed-catalog">(.*?)</script>', s, re.S).group(1)
    have = {r['id'] for r in json.loads(block)}
    new = [j for j in JOBS if j[0] not in have]
    if not new:
        print('all', len(JOBS), 'jobs already in the catalog')
        return
    lines = []
    for sid, cat, svc, hrs, note in new:
        row = {"id": sid, "sec": "General Labor", "cat": cat, "scope": "All", "svc": svc, "bill": "H", "hrs": hrs, "fix": None,
               "pol": POL, "note": note, "conf": "Medium", "ver": 1, "src": SRC,
               "ref": [round(hrs * 112.5, 2), round(hrs * 100, 2), round(hrs * 125, 2)]}
        lines.append(json.dumps(row, separators=(',', ':')) + ',')
    anchor = re.search(r'\{"id":"GEN-ELEC-010".*?\},\n', s)
    assert anchor, 'GEN-ELEC-010 not found'
    s = s[:anchor.end()] + '\n'.join(lines) + '\n' + s[anchor.end():]
    json.loads(re.search(r'<script type="application/json" id="seed-catalog">(.*?)</script>', s, re.S).group(1))   # still valid
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('added', len(new), 'jobs:', ', '.join(j[0] for j in new))


if __name__ == '__main__':
    main()
