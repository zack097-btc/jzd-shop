# The parts that usually go with each job in the shop's seed catalog.
#
#   python seed_job_parts.py        (run from the repository root)
#
# Writes the "seed-job-parts" block into index.html. Generic part names and
# typical quantities only: no brands, no part numbers, no prices. A shop fills
# in the part number and the price on the ticket when it orders the part. This
# is SHOP SEED data - it says what a job usually needs, never what fits a
# particular vehicle; fitment is checked when the part is ordered.
#
# Each entry: [name, qty, unit, kind, note]
#   kind  "part" or "fluid"
#   unit  ea, pair, set, kit, qt, gal, oz, can, bottle
#   note  shown on the line (e.g. "if equipped", "as needed")
# A job whose menu price already includes its parts lists them as INCLUDED:
# they go on the ticket at no charge so the ticket still says what was used.

import io, json, re

P, F = "part", "fluid"
AS_NEEDED = "as needed"
IF_EQ = "if equipped"

OIL_CAR = [["Engine oil", 5, "qt", F, "grade and capacity per vehicle"], ["Oil filter", 1, "ea", P, ""],
           ["Drain plug gasket / crush washer", 1, "ea", P, ""]]
OIL_SYN = [["Engine oil, full synthetic", 6, "qt", F, "grade and capacity per vehicle"], ["Oil filter", 1, "ea", P, ""],
           ["Drain plug gasket / crush washer", 1, "ea", P, ""]]
OIL_TRUCK = [["Engine oil", 7, "qt", F, "grade and capacity per vehicle"], ["Oil filter", 1, "ea", P, ""],
             ["Drain plug gasket / crush washer", 1, "ea", P, ""]]
OIL_DIESEL = [["Diesel engine oil", 3, "gal", F, "grade and capacity per engine"], ["Oil filter", 1, "ea", P, ""],
              ["Drain plug gasket / O-ring", 1, "ea", P, ""]]
OIL_BMW = [["Engine oil, BMW-approved synthetic", 7, "qt", F, "LL-01/LL-04 spec per vehicle; verify capacity"],
           ["Oil filter kit (element + O-rings)", 1, "kit", P, ""], ["Drain plug with washer", 1, "ea", P, ""]]
OIL_BMW_V8 = [["Engine oil, BMW-approved synthetic 10W-60 / per spec", 9, "qt", F, "verify grade and capacity"],
              ["Oil filter kit (element + O-rings)", 1, "kit", P, ""], ["Drain plug with washer", 1, "ea", P, ""]]
BRAKE_PADS = [["Brake pad set", 1, "set", P, "one axle"], ["Brake hardware / abutment clip kit", 1, "kit", P, ""],
              ["Brake wear sensor", 1, "ea", P, IF_EQ], ["Brake caliper grease", 1, "ea", F, AS_NEEDED],
              ["Brake parts cleaner", 1, "can", F, AS_NEEDED]]
BRAKE_PADS_ROTORS = [["Brake pad set", 1, "set", P, "one axle"], ["Brake rotor", 2, "ea", P, ""],
                     ["Brake hardware / abutment clip kit", 1, "kit", P, ""], ["Brake wear sensor", 1, "ea", P, IF_EQ],
                     ["Brake caliper grease", 1, "ea", F, AS_NEEDED], ["Brake parts cleaner", 1, "can", F, AS_NEEDED]]
BRAKE_FLUID = [["Brake fluid", 1, "qt", F, "DOT type per vehicle"]]
COOLANT_DF = [["Coolant, 50/50 premix", 2, "gal", F, "type per vehicle; capacity varies"]]
SPARK4 = [["Spark plug", 4, "ea", P, ""], ["Anti-seize / dielectric grease", 1, "ea", F, AS_NEEDED]]
SPARK6 = [["Spark plug", 6, "ea", P, ""], ["Anti-seize / dielectric grease", 1, "ea", F, AS_NEEDED]]
SPARK8 = [["Spark plug", 8, "ea", P, ""], ["Anti-seize / dielectric grease", 1, "ea", F, AS_NEEDED]]
WATER_PUMP = [["Water pump", 1, "ea", P, ""], ["Water pump gasket / O-ring", 1, "ea", P, "if not included with pump"],
              ["Coolant, 50/50 premix", 2, "gal", F, "type per vehicle"]]
THERMOSTAT = [["Thermostat", 1, "ea", P, ""], ["Thermostat gasket / O-ring", 1, "ea", P, "if not included"],
              ["Coolant, 50/50 premix", 1, "gal", F, "type per vehicle"]]
VALVE_COVER = [["Valve cover gasket set", 1, "set", P, "includes plug-tube seals where applicable"],
               ["RTV sealant", 1, "ea", F, AS_NEEDED]]
OIL_PAN = [["Oil pan gasket", 1, "ea", P, ""], ["RTV sealant", 1, "ea", F, AS_NEEDED],
           ["Engine oil", 5, "qt", F, "capacity per vehicle"], ["Oil filter", 1, "ea", P, ""]]
CLUTCH = [["Clutch kit (disc, pressure plate, release bearing)", 1, "kit", P, ""], ["Pilot bearing / bushing", 1, "ea", P, IF_EQ],
          ["Rear main seal", 1, "ea", P, "if leaking"], ["Flywheel", 1, "ea", P, "replace or resurface as needed"],
          ["Clutch hydraulic fluid / brake fluid", 1, "bottle", F, AS_NEEDED]]
DIFF_FLUID = [["Differential gear oil", 2, "qt", F, "type and capacity per axle; limited-slip additive if required"],
              ["Fill/drain plug gasket or crush washer", 2, "ea", P, ""]]
TCASE_FLUID = [["Transfer-case fluid", 2, "qt", F, "type and capacity per unit"], ["Fill/drain plug gasket or crush washer", 2, "ea", P, ""]]
ATF_DF = [["Automatic transmission fluid", 5, "qt", F, "spec and capacity per transmission"], ["Drain plug gasket / crush washer", 1, "ea", P, ""]]
ATF_PAN = [["Transmission filter kit (filter + pan gasket)", 1, "kit", P, ""], ["Automatic transmission fluid", 6, "qt", F, "spec and capacity per transmission"]]
PAN_8HP = [["Transmission oil pan with integrated filter", 1, "ea", P, ""], ["ZF / BMW-approved ATF", 7, "qt", F, "verify quantity"],
           ["Mechatronic sleeve / adapter seal", 1, "ea", P, ""]]
DCT = [["DCT filter kit", 1, "kit", P, ""], ["DCT pan gasket", 1, "ea", P, ""], ["DCT fluid, approved spec", 6, "qt", F, "verify quantity"]]
STRUT_PAIR = [["Strut assembly (loaded) or strut", 2, "ea", P, "one axle"], ["Strut mount / bearing", 2, "ea", P, "if not a loaded assembly"]]
SHOCK_PAIR = [["Shock absorber", 2, "ea", P, "one axle"], ["Shock mounting hardware / bushings", 1, "set", P, AS_NEEDED]]
HUB = [["Wheel hub / bearing assembly", 1, "ea", P, ""], ["Axle nut", 1, "ea", P, "replace if single-use"]]
CV_AXLE = [["CV axle assembly", 1, "ea", P, ""], ["Axle nut", 1, "ea", P, "replace if single-use"],
           ["Transmission / differential fluid top-off", 1, "qt", F, AS_NEEDED]]
UJOINT = [["U-joint", 1, "ea", P, ""], ["Grease", 1, "ea", F, AS_NEEDED]]
BELT = [["Serpentine / drive belt", 1, "ea", P, ""]]
GUIBO = [["Flex disc (guibo)", 1, "ea", P, ""], ["Flex disc bolts / nuts", 1, "set", P, "single-use"]]

JOB_PARTS = {
    # ---- tires ----
    "MENU-TIRE-001": [["Tire repair patch-plug", 1, "ea", P, "INCLUDED"], ["Valve stem", 1, "ea", P, AS_NEEDED]],
    "MENU-TIRE-002": [["Valve stem (rubber snap-in)", 1, "ea", P, "or TPMS service kit"], ["Wheel weights", 1, "set", P, "INCLUDED"]],
    "MENU-TIRE-003": [["Valve stem (rubber snap-in)", 1, "ea", P, "or TPMS service kit"], ["Wheel weights", 1, "set", P, "INCLUDED"]],
    "MENU-TIRE-004": [["Valve stem (rubber snap-in)", 1, "ea", P, "or TPMS service kit"], ["Wheel weights", 1, "set", P, "INCLUDED"]],
    "MENU-TIRE-005": [],
    "MENU-TIRE-006": [["Wheel weights", 1, "set", P, "INCLUDED"]],
    "MENU-TIRE-007": [],
    "MENU-TIRE-008": [],
    "MENU-TIRE-009": [["Wheel weights", 1, "set", P, "INCLUDED"]],
    "MENU-ALIGN-001": [],
    "MENU-TPMS-001": [["TPMS sensor", 1, "ea", P, ""], ["TPMS service kit (valve core, seal, nut, cap)", 1, "kit", P, ""]],
    "MENU-TPMS-002": [],
    # ---- oil services sold as a package: the oil and filter are in the price ----
    "MENU-LOF-001": [[n, q, u, k, "INCLUDED"] for n, q, u, k, _ in OIL_CAR],
    "MENU-LOF-002": [[n, q, u, k, "INCLUDED"] for n, q, u, k, _ in OIL_SYN],
    "MENU-LOF-003": [[n, q, u, k, "INCLUDED"] for n, q, u, k, _ in OIL_BMW],
    "MENU-LOF-004": [[n, q, u, k, "INCLUDED"] for n, q, u, k, _ in OIL_BMW_V8],
    "MENU-DIAG-001": [],
    "MENU-AC-001": [["Refrigerant R-134a", 1, "lb", F, "charge per vehicle; billed by weight"], ["UV leak dye", 1, "ea", F, AS_NEEDED],
                    ["A/C compressor oil", 1, "oz", F, AS_NEEDED]],
    # ---- diagnostics and tests: labor only ----
    **{k: [] for k in ["GEN-DIAG-001", "GEN-DIAG-002", "GEN-DIAG-003", "GEN-DIAG-004", "GEN-DIAG-005", "GEN-DIAG-006", "GEN-DIAG-007",
                       "GEN-DIAG-008", "GEN-ENG-019", "GEN-ENG-020", "GEN-COOL-010", "GEN-SUS-015", "GEN-ELEC-008", "GEN-ELEC-010",
                       "GEN-EXH-005", "GEN-ELEC-002", "GEN-DRV-001"]},
    # ---- maintenance ----
    "GEN-MAINT-001": OIL_CAR,
    "GEN-MAINT-002": OIL_TRUCK,
    "GEN-MAINT-003": [["Engine air filter", 1, "ea", P, ""]],
    "GEN-MAINT-004": [["Cabin air filter", 1, "ea", P, ""]],
    "GEN-MAINT-005": [["Wiper blade", 2, "ea", P, "sizes per vehicle"]],
    "GEN-MAINT-006": [["Brake fluid", 2, "qt", F, "DOT type per vehicle"]],
    "GEN-MAINT-007": COOLANT_DF,
    "GEN-MAINT-008": [["Coolant, 50/50 premix", 3, "gal", F, "type per vehicle"], ["Cooling-system flush chemical", 1, "ea", F, AS_NEEDED]],
    "GEN-MAINT-009": DIFF_FLUID,
    "GEN-MAINT-010": DIFF_FLUID,
    "GEN-MAINT-011": TCASE_FLUID,
    "GEN-MAINT-012": [["Manual transmission fluid", 3, "qt", F, "spec and capacity per transmission"], ["Fill/drain plug gasket or crush washer", 2, "ea", P, ""]],
    "GEN-MAINT-013": ATF_DF,
    "GEN-MAINT-014": ATF_PAN,
    "GEN-MAINT-015": [["Fuel filter", 1, "ea", P, ""], ["Fuel line clips / O-rings", 1, "set", P, AS_NEEDED]],
    # ---- engine ----
    "GEN-ENG-001": SPARK4, "GEN-ENG-002": SPARK6, "GEN-ENG-003": SPARK8,
    "GEN-ENG-004": [["Ignition coil", 1, "ea", P, ""], ["Spark plug", 1, "ea", P, "recommended with a coil"]],
    "GEN-ENG-005": BELT,
    "GEN-ENG-006": [["Belt tensioner", 1, "ea", P, "and/or idler pulley"], ["Idler pulley", 1, "ea", P, AS_NEEDED], ["Serpentine / drive belt", 1, "ea", P, "recommended"]],
    "GEN-ENG-007": [["Alternator", 1, "ea", P, "core charge may apply"], ["Serpentine / drive belt", 1, "ea", P, AS_NEEDED]],
    "GEN-ENG-008": [["Starter", 1, "ea", P, "core charge may apply"]],
    "GEN-ENG-009": VALVE_COVER, "GEN-ENG-010": [["Valve cover gasket set", 2, "set", P, "both banks"], ["RTV sealant", 1, "ea", F, AS_NEEDED]],
    "GEN-ENG-011": OIL_PAN, "GEN-ENG-012": OIL_PAN[:2] + [["Engine oil", 7, "qt", F, "capacity per vehicle"], ["Oil filter", 1, "ea", P, ""]],
    "GEN-ENG-013": [["Engine mount", 2, "ea", P, ""]],
    "GEN-ENG-014": [["Intake manifold gasket set", 1, "set", P, ""], ["Coolant", 1, "gal", F, "if coolant passages disturbed"]],
    "GEN-ENG-015": [["Throttle body", 1, "ea", P, "if replacing"], ["Throttle body gasket", 1, "ea", P, ""], ["Throttle body cleaner", 1, "can", F, AS_NEEDED]],
    "GEN-ENG-016": [["Oxygen sensor", 1, "ea", P, "position per diagnosis"], ["Anti-seize", 1, "ea", F, AS_NEEDED]],
    "GEN-ENG-017": [["High-pressure fuel pump", 1, "ea", P, ""], ["HPFP mounting seal / O-ring kit", 1, "kit", P, ""], ["HPFP follower / tappet", 1, "ea", P, IF_EQ]],
    "GEN-ENG-018": [["Fuel injector", 4, "ea", P, "quantity per engine"], ["Injector seal / O-ring kit", 1, "set", P, ""]],
    # ---- cooling ----
    "GEN-COOL-001": WATER_PUMP, "GEN-COOL-002": THERMOSTAT,
    "GEN-COOL-003": [["Radiator", 1, "ea", P, ""], ["Radiator hose clamps / O-rings", 1, "set", P, AS_NEEDED], ["Coolant, 50/50 premix", 2, "gal", F, "type per vehicle"]],
    "GEN-COOL-004": [["Upper radiator hose", 1, "ea", P, ""], ["Lower radiator hose", 1, "ea", P, ""], ["Hose clamp", 4, "ea", P, AS_NEEDED],
                     ["Coolant, 50/50 premix", 1, "gal", F, "type per vehicle"]],
    "GEN-COOL-005": [["Coolant expansion tank / reservoir", 1, "ea", P, ""], ["Reservoir cap", 1, "ea", P, "recommended"], ["Coolant, 50/50 premix", 1, "gal", F, ""]],
    "GEN-COOL-006": [["Cooling fan assembly", 1, "ea", P, ""]],
    "GEN-COOL-007": [["Heater hose", 1, "ea", P, ""], ["Hose clamp", 2, "ea", P, AS_NEEDED], ["Coolant, 50/50 premix", 1, "gal", F, ""]],
    "GEN-COOL-008": [["Heater core", 1, "ea", P, ""], ["Heater core seals / O-rings", 1, "set", P, ""], ["Coolant, 50/50 premix", 2, "gal", F, ""]],
    "GEN-COOL-009": [["Coolant temperature sensor", 1, "ea", P, ""], ["Sensor O-ring / seal", 1, "ea", P, ""], ["Coolant", 1, "qt", F, AS_NEEDED]],
    # ---- brakes ----
    "GEN-BRK-001": BRAKE_PADS, "GEN-BRK-002": BRAKE_PADS_ROTORS, "GEN-BRK-003": BRAKE_PADS_ROTORS,
    "GEN-BRK-004": [["Brake caliper", 1, "ea", P, "core charge may apply"], ["Caliper banjo bolt copper washers", 2, "ea", P, ""]] + BRAKE_FLUID,
    "GEN-BRK-005": [["Brake hose", 1, "ea", P, ""], ["Banjo bolt copper washers", 2, "ea", P, ""]] + BRAKE_FLUID,
    "GEN-BRK-006": [["Brake master cylinder", 1, "ea", P, ""], ["Brake fluid", 2, "qt", F, "DOT type per vehicle"]],
    "GEN-BRK-007": [["Brake booster", 1, "ea", P, ""], ["Booster check valve / vacuum hose", 1, "ea", P, AS_NEEDED]],
    "GEN-BRK-008": [["Brake shoe set", 1, "set", P, "one axle"], ["Drum brake hardware kit", 1, "kit", P, ""], ["Wheel cylinder", 2, "ea", P, "if leaking"],
                    ["Brake drum", 2, "ea", P, "replace or resurface as needed"]],
    "GEN-BRK-009": [["Parking brake shoe set", 1, "set", P, ""], ["Parking brake hardware kit", 1, "kit", P, ""], ["Parking brake cable", 1, "ea", P, AS_NEEDED]],
    "GEN-BRK-010": [["ABS wheel speed sensor", 1, "ea", P, ""]],
    # ---- suspension and steering ----
    "GEN-SUS-001": STRUT_PAIR, "GEN-SUS-002": SHOCK_PAIR,
    "GEN-SUS-003": [["Control arm (with bushings / ball joint as supplied)", 1, "ea", P, ""], ["Control arm bolts / nuts", 1, "set", P, "single-use where specified"]],
    "GEN-SUS-004": [["Ball joint", 1, "ea", P, ""], ["Cotter pin / castle nut", 1, "ea", P, ""]],
    "GEN-SUS-005": [["Outer tie rod end", 1, "ea", P, ""], ["Cotter pin / castle nut", 1, "ea", P, ""]],
    "GEN-SUS-006": [["Inner tie rod", 1, "ea", P, ""], ["Outer tie rod end", 1, "ea", P, ""], ["Steering rack boot kit", 1, "kit", P, "recommended"]],
    "GEN-SUS-007": [["Sway bar end link", 2, "ea", P, ""]],
    "GEN-SUS-008": [["Sway bar bushing", 2, "ea", P, ""], ["Sway bar bushing bracket", 2, "ea", P, AS_NEEDED]],
    "GEN-SUS-009": HUB,
    "GEN-SUS-010": [["Wheel bearing", 1, "ea", P, ""], ["Bearing snap ring / retaining clip", 1, "ea", P, ""], ["Axle nut", 1, "ea", P, "replace if single-use"]],
    "GEN-SUS-011": CV_AXLE,
    "GEN-SUS-012": [["Steering rack", 1, "ea", P, "core charge may apply"], ["Outer tie rod end", 2, "ea", P, AS_NEEDED],
                    ["Power steering fluid", 1, "qt", F, "if hydraulic; type per vehicle"]],
    "GEN-SUS-013": [["Power steering pump", 1, "ea", P, "core charge may apply"], ["Power steering fluid", 1, "qt", F, "type per vehicle"],
                    ["Pressure line O-rings / seals", 1, "set", P, AS_NEEDED]],
    "GEN-SUS-014": [["Coil spring", 2, "ea", P, ""], ["Spring isolator / seat", 2, "ea", P, AS_NEEDED]],
    # ---- drivetrain ----
    "GEN-DRV-002": GUIBO,
    "GEN-DRV-003": [["Driveshaft center support bearing", 1, "ea", P, ""]],
    "GEN-DRV-004": CLUTCH, "GEN-DRV-005": CLUTCH, "GEN-DRV-006": CLUTCH,
    "GEN-DRV-007": [["Automatic transmission fluid", 10, "qt", F, "spec and capacity per transmission"], ["Transmission cooler line O-rings", 1, "set", P, AS_NEEDED],
                    ["Torque converter / output seals", 1, "set", P, AS_NEEDED]],
    "GEN-DRV-008": [["Differential gear oil", 2, "qt", F, "type and capacity per axle"], ["Axle / pinion seals", 1, "set", P, AS_NEEDED]],
    "GEN-DRV-009": [["Axle / output shaft seal", 1, "ea", P, ""], ["Transmission / differential fluid top-off", 1, "qt", F, AS_NEEDED]],
    "GEN-DRV-010": [["Transmission mount", 1, "ea", P, "quantity per vehicle"]],
    "GEN-DRV-011": [["Transfer-case fluid", 2, "qt", F, "type and capacity per unit"], ["Transfer-case seals / gaskets", 1, "set", P, AS_NEEDED]],
    "GEN-DRV-012": [["Pinion seal", 1, "ea", P, ""], ["Pinion nut", 1, "ea", P, "single-use where specified"], ["Differential gear oil", 1, "qt", F, "top-off"]],
    # ---- electrical and HVAC ----
    "GEN-ELEC-001": [["Battery", 1, "ea", P, "group size per vehicle; core charge may apply"], ["Battery terminal protectant", 1, "ea", F, AS_NEEDED]],
    "GEN-ELEC-003": [["Headlamp bulb", 2, "ea", P, "type per vehicle"]],
    "GEN-ELEC-004": [["Window regulator (with motor if integrated)", 1, "ea", P, ""], ["Door panel clips", 1, "set", P, AS_NEEDED]],
    "GEN-ELEC-005": [["Blower motor", 1, "ea", P, ""], ["Blower motor resistor / regulator", 1, "ea", P, "if faulty"]],
    "GEN-ELEC-006": [["A/C compressor", 1, "ea", P, ""], ["Receiver-drier / accumulator", 1, "ea", P, ""], ["Expansion valve / orifice tube", 1, "ea", P, ""],
                     ["A/C O-ring kit", 1, "kit", P, ""], ["A/C compressor oil", 1, "oz", F, "quantity per system"], ["Refrigerant", 1, "lb", F, "charge per vehicle"]],
    "GEN-ELEC-007": [["A/C condenser", 1, "ea", P, ""], ["Receiver-drier / accumulator", 1, "ea", P, "recommended"], ["A/C O-ring kit", 1, "kit", P, ""],
                     ["A/C compressor oil", 1, "oz", F, AS_NEEDED], ["Refrigerant", 1, "lb", F, "charge per vehicle"]],
    "GEN-ELEC-009": [["Fuse / relay", 1, "ea", P, AS_NEEDED], ["Wire, terminals, heat-shrink", 1, "set", P, AS_NEEDED]],
    # ---- exhaust ----
    "GEN-EXH-001": [["Cat-back exhaust system", 1, "ea", P, ""], ["Exhaust gaskets", 1, "set", P, ""], ["Exhaust hangers", 1, "set", P, AS_NEEDED], ["Exhaust clamps / bolts", 1, "set", P, ""]],
    "GEN-EXH-002": [["Muffler", 1, "ea", P, ""], ["Exhaust clamp", 2, "ea", P, ""], ["Exhaust hanger", 1, "ea", P, AS_NEEDED]],
    "GEN-EXH-003": [["Catalytic converter (emissions-compliant for the vehicle)", 1, "ea", P, "CARB/EPA compliance per vehicle"], ["Exhaust gaskets", 1, "set", P, ""],
                    ["Exhaust bolts / nuts", 1, "set", P, ""], ["Oxygen sensor", 1, "ea", P, AS_NEEDED]],
    "GEN-EXH-004": [["Exhaust manifold gasket", 1, "ea", P, ""], ["Exhaust manifold studs / nuts", 1, "set", P, "if broken or seized"]],
    # ---- trucks ----
    "TRK-MAINT-001": OIL_TRUCK, "TRK-MAINT-002": OIL_DIESEL,
    "TRK-MAINT-003": [["Diesel fuel filter", 1, "ea", P, "quantity per engine (primary / secondary)"], ["Fuel filter O-rings / seals", 1, "set", P, ""]],
    "TRK-MAINT-004": [["Differential gear oil (front)", 2, "qt", F, "type and capacity per axle"], ["Differential gear oil (rear)", 3, "qt", F, "limited-slip additive if required"],
                      ["Fill/drain plug gaskets", 4, "ea", P, ""]],
    "TRK-MAINT-005": TCASE_FLUID,
    "TRK-BRK-001": BRAKE_PADS_ROTORS, "TRK-BRK-002": BRAKE_PADS_ROTORS, "TRK-BRK-003": BRAKE_PADS_ROTORS,
    "TRK-BRK-004": [["Parking brake shoe set", 1, "set", P, ""], ["Parking brake hardware kit", 1, "kit", P, ""]],
    "TRK-BRK-005": [["Brake caliper", 1, "ea", P, "core charge may apply"], ["Caliper banjo bolt copper washers", 2, "ea", P, ""]] + BRAKE_FLUID,
    "TRK-SUS-001": HUB, "TRK-SUS-002": HUB, "TRK-SUS-003": CV_AXLE,
    "TRK-SUS-004": [["Upper control arm", 1, "ea", P, ""], ["Control arm bolts / cam bolts", 1, "set", P, AS_NEEDED]],
    "TRK-SUS-005": [["Lower control arm", 1, "ea", P, ""], ["Control arm bolts / cam bolts", 1, "set", P, AS_NEEDED]],
    "TRK-SUS-006": [["Upper ball joint", 1, "ea", P, ""], ["Cotter pin / castle nut", 1, "ea", P, ""]],
    "TRK-SUS-007": [["Lower ball joint", 1, "ea", P, ""], ["Cotter pin / castle nut", 1, "ea", P, ""]],
    "TRK-SUS-008": [["Outer tie rod end", 1, "ea", P, ""], ["Cotter pin / castle nut", 1, "ea", P, ""]],
    "TRK-SUS-009": [["Inner tie rod", 1, "ea", P, ""], ["Outer tie rod end", 1, "ea", P, ""], ["Tie rod adjusting sleeve", 1, "ea", P, IF_EQ]],
    "TRK-SUS-010": SHOCK_PAIR, "TRK-SUS-011": SHOCK_PAIR,
    "TRK-SUS-012": [["Leaf spring pack", 1, "ea", P, ""], ["U-bolt kit", 1, "kit", P, "replace with the spring"], ["Leaf spring bushings", 1, "set", P, AS_NEEDED]],
    "TRK-SUS-013": [["Leaf spring shackle kit", 2, "kit", P, ""], ["Spring hanger", 1, "ea", P, AS_NEEDED]],
    "TRK-STR-001": [["Pitman arm", 1, "ea", P, ""], ["Pitman arm nut / cotter pin", 1, "ea", P, ""]],
    "TRK-STR-002": [["Idler arm", 1, "ea", P, ""], ["Idler arm mounting hardware", 1, "set", P, AS_NEEDED]],
    "TRK-STR-003": [["Steering gear box", 1, "ea", P, "core charge may apply"], ["Power steering fluid", 1, "qt", F, "type per vehicle"]],
    "TRK-DRV-001": [["U-joint", 2, "ea", P, "inspect and replace as needed"]],
    "TRK-DRV-002": UJOINT, "TRK-DRV-003": [["U-joint", 2, "ea", P, ""], ["Grease", 1, "ea", F, AS_NEEDED]],
    "TRK-DRV-004": [["Front axle U-joint", 1, "ea", P, ""], ["Axle seal", 1, "ea", P, AS_NEEDED]],
    "TRK-DRV-005": [["Differential cover gasket", 1, "ea", P, "or RTV sealant"], ["Differential gear oil", 3, "qt", F, "type and capacity per axle"]],
    "TRK-DRV-006": [["Pinion seal", 1, "ea", P, ""], ["Pinion nut", 1, "ea", P, "single-use where specified"], ["Differential gear oil", 1, "qt", F, "top-off"]],
    "TRK-DRV-007": [["Rear axle shaft seal", 1, "ea", P, ""], ["Axle bearing", 1, "ea", P, "if worn"], ["Differential cover gasket", 1, "ea", P, "if C-clip axle"],
                    ["Differential gear oil", 3, "qt", F, ""]],
    "TRK-DRV-008": ATF_PAN,
    "TRK-ENG-001": WATER_PUMP, "TRK-ENG-002": [["Alternator", 1, "ea", P, "core charge may apply"]], "TRK-ENG-003": [["Starter", 1, "ea", P, "core charge may apply"]],
    "TRK-ENG-004": SPARK8, "TRK-ENG-005": BELT, "TRK-ENG-006": [["Engine mount", 2, "ea", P, ""]],
    "TRK-DSL-001": [["Battery (diesel dual set)", 2, "ea", P, "group size per vehicle; core charges may apply"]],
    "TRK-DSL-002": BELT,
    "TRK-DSL-003": [["Glow plug", 8, "ea", P, "quantity per engine"], ["Anti-seize", 1, "ea", F, AS_NEEDED]],
    "TRK-DSL-004": [["Turbocharger", 1, "ea", P, "core charge may apply"], ["Turbo gasket and seal kit", 1, "kit", P, ""],
                    ["Oil feed / drain line seals", 1, "set", P, ""], ["Engine oil", 1, "gal", F, "prime / top-off"]],
    "TRK-DSL-005": [["Fuel injector", 8, "ea", P, "quantity per engine; core charges may apply"], ["Injector seal / O-ring kit", 1, "set", P, ""],
                    ["Injector hold-down bolts", 1, "set", P, "single-use where specified"]],
    "TRK-DSL-006": [["EGR cooler", 1, "ea", P, ""], ["EGR cooler gasket kit", 1, "kit", P, ""], ["Coolant", 2, "gal", F, "type per engine"]],
    "TRK-ELEC-001": [["7-pin trailer connector", 1, "ea", P, AS_NEEDED], ["Wire, terminals, heat-shrink", 1, "set", P, AS_NEEDED]],
    "TRK-ELEC-002": [["Trailer brake controller", 1, "ea", P, ""], ["Brake controller vehicle harness", 1, "ea", P, ""]],
    "TRK-TOW-001": [["Receiver hitch", 1, "ea", P, ""], ["Hitch mounting hardware", 1, "set", P, "usually included"], ["Hitch wiring harness", 1, "ea", P, "if requested"]],
}

# ---- BMW M3 families ----
def m3(prefix, jobs):
    for k, v in jobs.items():
        JOB_PARTS[prefix + k] = v

M3_BRAKES = [["Brake pad set", 1, "set", P, "one axle"], ["Brake rotor", 2, "ea", P, ""], ["Brake wear sensor", 1, "ea", P, ""],
             ["Brake parts cleaner", 1, "can", F, AS_NEEDED]]
m3("M3-E30-", {"001": OIL_BMW, "002": [["Valve cover gasket", 1, "ea", P, "recommended with an adjustment"]], "003": SPARK4,
               "004": WATER_PUMP, "005": THERMOSTAT, "006": VALVE_COVER, "007": CLUTCH, "008": GUIBO + [["Driveshaft center support bearing", 1, "ea", P, "if worn"]],
               "009": [["Front control arm", 2, "ea", P, "or bushings only"], ["Control arm bushing", 2, "ea", P, ""]], "010": M3_BRAKES})
m3("M3-E36-", {"001": OIL_BMW, "002": SPARK6, "003": VALVE_COVER, "004": WATER_PUMP,
               "005": [["Thermostat with housing", 1, "ea", P, ""], ["Thermostat housing gasket", 1, "ea", P, ""], ["Coolant, 50/50 premix", 1, "gal", F, "BMW-approved"]],
               "006": [["Radiator", 1, "ea", P, ""], ["Radiator hose kit", 1, "kit", P, "recommended"], ["Coolant, 50/50 premix", 2, "gal", F, "BMW-approved"]],
               "007": CLUTCH, "008": GUIBO, "009": [["Rear trailing arm bushing", 2, "ea", P, ""]],
               "010": [["Front control arm bushing", 2, "ea", P, ""]], "011": [["VANOS seal kit", 1, "kit", P, ""], ["VANOS gasket", 1, "ea", P, ""], ["Engine oil", 2, "qt", F, "top-off"]],
               "012": M3_BRAKES})
m3("M3-E46-", {"001": OIL_BMW, "002": [["Valve cover gasket set", 1, "set", P, ""], ["Valve adjustment shims", 1, "set", P, "as measured"]], "003": SPARK6,
               "004": VALVE_COVER, "005": [["Connecting rod bearing set", 1, "set", P, ""], ["Connecting rod bolts", 12, "ea", P, "single-use"],
                                           ["Oil pan gasket", 1, "ea", P, ""], ["Oil pump bolts", 1, "set", P, AS_NEEDED], ["Engine oil", 7, "qt", F, ""], ["Oil filter kit", 1, "kit", P, ""]],
               "006": [["VANOS seal and bearing kit", 1, "kit", P, ""], ["VANOS oil pump disc / bolts", 1, "set", P, AS_NEEDED], ["Valve cover gasket set", 1, "set", P, ""]],
               "007": WATER_PUMP, "008": THERMOSTAT, "009": CLUTCH,
               "010": [["Rear subframe reinforcement plate kit", 1, "kit", P, ""], ["Seam sealer / undercoating", 1, "ea", F, ""]],
               "011": [["Rear trailing arm bushing", 2, "ea", P, ""]], "012": OIL_PAN,
               "013": [["Differential gear oil", 2, "qt", F, "BMW-approved"], ["Fill/drain plugs", 2, "ea", P, ""]], "014": M3_BRAKES})
m3("M3-E9X-", {"001": OIL_BMW_V8, "002": SPARK8,
               "003": [["Connecting rod bearing set", 1, "set", P, ""], ["Connecting rod bolts", 16, "ea", P, "single-use"], ["Oil pan gasket", 1, "ea", P, ""],
                       ["Engine oil", 9, "qt", F, ""], ["Oil filter kit", 1, "kit", P, ""]],
               "004": [["Throttle actuator", 2, "ea", P, ""]], "005": [["Valve cover gasket set", 2, "set", P, "both banks"]], "006": OIL_PAN,
               "007": WATER_PUMP, "008": THERMOSTAT, "009": DCT, "010": CLUTCH, "011": [["Engine mount", 2, "ea", P, ""]],
               "012": [["Differential gear oil", 2, "qt", F, "BMW-approved"], ["Fill/drain plugs", 2, "ea", P, ""]], "013": M3_BRAKES})
m3("M3-F80-", {"001": OIL_BMW, "002": SPARK6, "003": [["Ignition coil", 6, "ea", P, ""]], "004": WATER_PUMP, "005": VALVE_COVER, "006": OIL_PAN,
               "007": [["Crank hub lock / upgrade kit", 1, "kit", P, ""], ["Crank bolt", 1, "ea", P, "single-use"], ["Front crank seal", 1, "ea", P, ""]],
               "008": [["Charge pipe", 1, "ea", P, "quantity per repair"], ["Charge pipe O-rings / clamps", 1, "set", P, ""]], "009": DCT, "010": CLUTCH,
               "011": [["Differential gear oil", 2, "qt", F, "BMW-approved"], ["Fill/drain plugs", 2, "ea", P, ""]], "012": M3_BRAKES})
m3("M3-G80-", {"001": OIL_BMW, "002": SPARK6, "003": VALVE_COVER, "004": WATER_PUMP, "005": PAN_8HP, "006": CLUTCH, "007": TCASE_FLUID,
               "008": DIFF_FLUID, "009": [["Differential gear oil", 2, "qt", F, "BMW-approved"], ["Fill/drain plugs", 2, "ea", P, ""]], "010": M3_BRAKES,
               "011": [["Brake fluid", 2, "qt", F, "BMW-approved DOT 4"]],
               "012": [["Battery (AGM / as fitted)", 1, "ea", P, "type per vehicle; must be registered"]]})


def main():
    path = 'index.html'
    s = io.open(path, encoding='utf-8').read()
    seed = json.loads(re.search(r'<script type="application/json" id="seed-catalog">(.*?)</script>', s, re.S).group(1))
    ids = [r['id'] for r in seed]
    missing = [i for i in ids if i not in JOB_PARTS]
    extra = [i for i in JOB_PARTS if i not in set(ids)]
    assert not missing, 'jobs without a parts entry (use [] for labor-only): ' + ', '.join(missing)
    assert not extra, 'parts for jobs that are not in the catalog: ' + ', '.join(extra)
    out = {}
    for i in ids:
        rows = []
        for n, q, u, k, note in JOB_PARTS[i]:
            assert k in (P, F) and isinstance(q, (int, float)) and q > 0 and n, (i, n)
            rows.append([n, q, u, k, note])
        if rows:
            out[i] = rows
    block = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    tag = '<script type="application/json" id="seed-job-parts">'
    if tag in s:
        s = re.sub(r'<script type="application/json" id="seed-job-parts">.*?</script>', lambda m: tag + block + '</script>', s, flags=re.S)
    else:
        anchor = '<script type="application/json" id="seed-catalog">'
        s = s.replace(anchor, tag + block + '</script>\n' + anchor, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('jobs with parts:', len(out), 'of', len(ids), '| part lines:', sum(len(v) for v in out.values()))


if __name__ == '__main__':
    main()
