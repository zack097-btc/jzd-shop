/* Attachments.

   A photograph of a 2/32 tyre is the most persuasive thing this shop owns and
   it is worthless if it cannot be produced six months later, so these checks
   care about bytes rather than records. A backup that restores the book and
   loses the photographs would pass a metadata test and fail the shop; the
   round-trip below therefore wipes storage entirely, restores from the package,
   and reads the actual image back out to compare it byte for byte with what
   went in.

   The network is never touched. */
const { chromium } = require('playwright');

const APP = 'file://' + process.cwd().replace(/\\/g, '/') + '/index.html';
const LS_KEY = 'jzd.shop.db';

const results = {};
const failures = [];
function check(name, cond, detail) {
  results[name] = cond ? 'PASS' : ('FAIL' + (detail ? ' — ' + detail : ''));
  if (!cond) failures.push(name + (detail ? ': ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('PAGEERR: ' + e.message));
  page.on('dialog', d => d.accept());

  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);

  /* A real PNG, drawn in the page, so what is stored is genuine image bytes
     with a genuine header rather than a string pretending to be one. These go
     in again after every reload, since a reload is the point of some checks. */
  const helpers = () => {
    window.makePng = (w, h, colour) => new Promise(res => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = colour; x.fillRect(0, 0, w, h);
      x.fillStyle = '#000'; x.fillRect(0, 0, 8, 8);
      c.toBlob(b => res(b), 'image/png');
    });
    window.asFile = (blob, name) => new File([blob], name, { type: blob.type });
    window.sha = async blob => {
      const buf = await blob.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
    };
    window.b64ToBlob = (b64, mime) => {
      const bin = atob(b64); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: mime });
    };
  };
  await page.evaluate(helpers);

  /* ---- 1,2,3,4,5,6. adding photographs in every context ---- */
  results.add = await page.evaluate(async () => {
    db.customers.c1 = { id: 'c1', name: 'Dale Hansen' };
    db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'WBS8M9C55J5J78069', plate: 'JZD-M3' };
    editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
    const o = cur;

    const vehPng = await makePng(60, 40, '#3366cc');
    const vehMeta = await attAdd(asFile(vehPng, 'vehicle front.png'), 'vehicle', 'v1', { vehicleId: 'v1' });

    const d1 = addDamage(o, 'LF door', 'Scratch', 'Light', 'below the handle', 'Zack');
    const d2 = addDamage(o, 'RF wheel', 'Curb rash', 'Moderate', 'outer lip', 'Zack');
    const dmgPng = await makePng(50, 50, '#cc3333');
    const dmgMeta = await attAdd(asFile(dmgPng, 'door scratch.png'), 'damage', d1.id, { orderId: o.id, vehicleId: 'v1' });
    const dmgMeta2 = await attAdd(asFile(await makePng(50, 50, '#33cc33'), 'wheel.png'), 'damage', d2.id, { orderId: o.id });

    const insp = newInspection(o.id, 'v1');
    insp.tech = 'Marco';
    const key = 'tires.tire.RR';
    setInspState(insp, key, 'Urgent');
    inspItem(insp, key).meas.tread = '3';
    const p1 = await attAdd(asFile(await makePng(70, 50, '#996633'), 'tyre1.png'), 'insp', insp.id + '|' + key, { orderId: o.id });
    const p2 = await attAdd(asFile(await makePng(70, 50, '#663399'), 'tyre2.png'), 'insp', insp.id + '|' + key, { orderId: o.id });
    /* one for the customer, one kept in the shop */
    p1.custVisible = true; p1.caption = 'Right rear at 3/32';
    p2.custVisible = false; p2.caption = 'internal reference';

    const brakeKey = 'brakes.pads.RR';
    setInspState(insp, brakeKey, 'Needs Attention');
    const bp = await attAdd(asFile(await makePng(60, 60, '#222222'), 'brake.png'), 'insp', insp.id + '|' + brakeKey, { orderId: o.id });
    bp.custVisible = true;
    saveOrder();

    return { vehId: vehMeta.id, vehCtx: vehMeta.ctx, vehName: vehMeta.name,
             d1: d1.id, d2: d2.id, dmgId: dmgMeta.id, dmgId2: dmgMeta2.id,
             inspId: insp.id, key, brakeKey, p1: p1.id, p2: p2.id, bp: bp.id,
             onDamage1: attsFor('damage', d1.id).length,
             onItem: attsFor('insp', insp.id + '|' + key).length,
             total: Object.keys(db.attachments).length,
             thumbs: [vehMeta, dmgMeta, p1].every(a => a.thumb && a.thumb.indexOf('data:image/') === 0),
             sizes: [vehMeta.size, dmgMeta.size, p1.size].every(n => n > 0),
             bookHasNoBytes: JSON.stringify(db.attachments).indexOf(';base64,iVBOR') < 0 };
  });
  const A = results.add;
  check('1. a photograph attaches to a vehicle', !!A.vehId && A.vehCtx === 'vehicle' && A.vehName === 'vehicle front.png', JSON.stringify(A));
  check('2. a photograph attaches to an intake damage entry', !!A.dmgId && A.onDamage1 === 1, JSON.stringify(A));
  check('3. a photograph attaches to an inspection item', !!A.p1, JSON.stringify(A));
  check('4. one finding can hold several photographs', A.onItem === 2, JSON.stringify(A));
  check('5. every attachment records a size and a thumbnail', A.sizes && A.thumbs, JSON.stringify(A));
  check('6. the book holds records, not image bytes', A.bookHasNoBytes && A.total === 6, JSON.stringify(A));

  /* ---- 7,8. visibility flags ---- */
  results.vis = await page.evaluate(b => ({
    custVisible: db.attachments[b.p1].custVisible, internal: db.attachments[b.p2].custVisible,
    caption: db.attachments[b.p1].caption,
    custList: custPhotos('insp', b.inspId + '|' + b.key).map(a => a.id)
  }), A);
  check('7. a photograph marked for the customer stays marked',
    results.vis.custVisible === true && /3\/32/.test(results.vis.caption) &&
    results.vis.custList.length === 1 && results.vis.custList[0] === A.p1, JSON.stringify(results.vis));
  check('8. a photograph kept internal is never in the customer list',
    results.vis.internal === false && results.vis.custList.indexOf(A.p2) < 0, JSON.stringify(results.vis));

  /* ---- 9. a recommendation points at the same files ---- */
  results.rec = await page.evaluate(b => {
    editOrder(Object.values(db.orders)[0].id);
    const insp = inspectionFor(cur);
    const f = inspFindings(insp).find(x => x.key === b.key);
    const rec = recFromFinding(cur, f);
    saveOrder();
    return { photos: rec.photos, sameFiles: (rec.photos || []).every(id => !!db.attachments[id]),
             noDuplicateBytes: Object.keys(db.attachments).length,
             custOnRec: custPhotos('rec', rec.id, rec.photos).map(x => x.id), recId: rec.id };
  }, A);
  check('9. a recommendation references the finding\'s photographs without copying them',
    results.rec.photos.length === 2 && results.rec.sameFiles &&
    results.rec.noDuplicateBytes === 6 && results.rec.custOnRec.length === 1,
    JSON.stringify(results.rec));

  /* ---- 10,11. names: duplicates and nasty ones ---- */
  results.names = await page.evaluate(async b => {
    const a1 = await attAdd(asFile(await makePng(20, 20, '#111'), 'photo.png'), 'damage', b.d2, {});
    const a2 = await attAdd(asFile(await makePng(20, 20, '#222'), 'photo.png'), 'damage', b.d2, {});
    const nasty = await attAdd(asFile(await makePng(20, 20, '#333'), '../../evil<>:"|?*.png'), 'damage', b.d2, {});
    return { differentIds: a1.id !== a2.id, differentFiles: a1.file !== a2.file,
             bothPresent: attsFor('damage', b.d2).length,
             sanitized: nasty.name, hasNoSlash: !/[\/\\]/.test(nasty.name),
             hasNoDots: nasty.name.indexOf('..') < 0,
             idSafe: /^[a-z0-9-]+$/.test(nasty.id) };
  }, A);
  const N = results.names;
  check('10. two files with the same name do not collide',
    N.differentIds && N.differentFiles && N.bothPresent === 4, JSON.stringify(N));
  check('11. a hostile filename is sanitized and never becomes a path',
    N.hasNoSlash && N.hasNoDots && N.idSafe && N.sanitized.indexOf('evil') >= 0, JSON.stringify(N));

  /* ---- 12. the bytes that came out are the bytes that went in ---- */
  results.bytes = await page.evaluate(async b => {
    const src = await makePng(64, 48, '#0088ff');
    const before = await sha(src);
    const meta = await attAdd(asFile(src, 'checksum.png'), 'insp', b.inspId + '|' + b.brakeKey, {});
    const b64 = await attGet(meta.id);
    const after = await sha(b64ToBlob(b64, 'image/png'));
    const bin = atob(b64);
    return { before, after, same: before === after, id: meta.id,
             isPng: bin.charCodeAt(0) === 0x89 && bin.slice(1, 4) === 'PNG', bytes: bin.length };
  }, A);
  check('12. a stored photograph reads back byte for byte, and is still a PNG',
    results.bytes.same && results.bytes.isPng && results.bytes.bytes > 50, JSON.stringify(results.bytes));

  /* ---- 13,14,15,16. backup, wipe, restore, and open the photograph again ---- */
  results.backup = await page.evaluate(async b => {
    const built = await buildBackup();
    const pkgText = JSON.stringify(built.pkg);
    const before = {
      attachments: Object.keys(db.attachments).length,
      files: Object.keys(built.pkg.files).length,
      missing: built.missing.length,
      itemPhotos: attsFor('insp', b.inspId + '|' + b.key).length,
      damagePhotos: attsFor('damage', b.d1).length,
      recPhotos: (Object.values(db.recommendations)[0].photos || []).length,
      sample: await sha(b64ToBlob(await attGet(b.p1), 'image/png')),
      sampleCaption: db.attachments[b.p1].caption
    };
    /* the isolated restore: throw away the working data AND every stored file,
       exactly as a new machine would look */
    Object.keys(db.attachments).forEach(id => localStorage.removeItem('jzd.att.' + id));
    db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
    const wiped = { attachments: Object.keys(db.attachments).length,
                    storage: Object.keys(localStorage).filter(k => k.indexOf('jzd.att.') === 0).length };

    const res = await restoreBackupPackage(JSON.parse(pkgText));
    const insp = Object.values(db.inspections)[0];
    const rec = Object.values(db.recommendations)[0];
    const order = Object.values(db.orders)[0];
    const dmg = order.checkin.damage[0];
    const itemPhotos = attsFor('insp', insp.id + '|' + b.key);
    /* the restored photograph must actually open */
    const restored = itemPhotos.find(a => a.caption === before.sampleCaption);
    const after = restored ? await sha(b64ToBlob(await attGet(restored.id), 'image/png')) : null;
    const bin = restored ? atob(await attGet(restored.id)) : '';
    return { before, wiped, res,
             after: { attachments: Object.keys(db.attachments).length,
                      itemPhotos: itemPhotos.length,
                      damagePhotos: attsFor('damage', dmg.id).length,
                      recPhotos: (rec.photos || []).length,
                      recPointsAtLiveFiles: (rec.photos || []).every(id => !!db.attachments[id]),
                      sample: after, stillPng: bin.charCodeAt(0) === 0x89 && bin.slice(1, 4) === 'PNG',
                      custStillMarked: restored ? restored.custVisible : null,
                      captionKept: restored ? restored.caption : null } };
  }, A);
  const B = results.backup;
  check('13. a backup package contains the physical attachments, not just their records',
    B.before.files === B.before.attachments && B.before.missing === 0, JSON.stringify(B.before));
  check('14. restoring into empty storage puts every file back',
    B.wiped.attachments === 0 && B.wiped.storage === 0 &&
    B.after.attachments === B.before.attachments && B.res.files === B.before.files,
    JSON.stringify({ w: B.wiped, r: B.res, a: B.after }));
  check('15. a restored photograph opens, and is the same image that went in',
    B.after.sample === B.before.sample && B.after.stillPng, JSON.stringify(B.after));
  check('16. restored photographs are still attached to the right item, damage entry and recommendation',
    B.after.itemPhotos === B.before.itemPhotos && B.after.damagePhotos === B.before.damagePhotos &&
    B.after.recPhotos === B.before.recPhotos && B.after.recPointsAtLiveFiles &&
    B.after.custStillMarked === true && B.after.captionKept === B.before.sampleCaption,
    JSON.stringify(B.after));

  /* ---- 17. a missing file is survivable ---- */
  results.missing = await page.evaluate(async () => {
    const id = Object.keys(db.attachments)[0];
    const meta = db.attachments[id];
    localStorage.removeItem('jzd.att.' + id);
    let threw = null, opened = false;
    try { await viewPhoto(id); opened = true; } catch (e) { threw = e.message; }
    const shown = document.getElementById('viewerBody').textContent;
    closeViewer();
    return { threw, opened, stillRecorded: !!db.attachments[id], flagged: !!db.attachments[id].missing,
             saysSo: /ATTACHMENT FILE MISSING/.test(shown), keepsName: shown.indexOf(meta.name) >= 0 };
  });
  const Mi = results.missing;
  check('17. a missing file says so, keeps its record, and does not take the program down',
    !Mi.threw && Mi.opened && Mi.stillRecorded && Mi.flagged && Mi.saysSo && Mi.keepsName, JSON.stringify(Mi));

  /* ---- 18. an old backup, with no package around it ---- */
  results.oldBackup = await page.evaluate(async () => {
    const plain = { settings: { shopName: 'Old Shop', laborRate: 100, taxRate: 5 },
                    customers: { x: { id: 'x', name: 'Old' } }, vehicles: {}, orders: {},
                    catalog: { labor: {}, parts: {} } };
    let threw = null, res = null;
    try { res = await restoreBackupPackage(plain); } catch (e) { threw = e.message; }
    return { threw, res, name: db.settings.shopName, rate: db.settings.laborRate,
             attachments: Object.keys(db.attachments).length, insp: !!db.inspections };
  });
  check('18. a backup from before photographs existed still restores',
    !results.oldBackup.threw && results.oldBackup.name === 'Old Shop' &&
    results.oldBackup.rate === 100 && results.oldBackup.attachments === 0 && results.oldBackup.insp,
    JSON.stringify(results.oldBackup));

  /* rubbish must be refused rather than adopted */
  results.rubbish = await page.evaluate(async () => {
    let threw = null;
    try { await restoreBackupPackage({ nonsense: true }); } catch (e) { threw = e.message; }
    return { threw, shopIntact: db.settings.shopName === 'Old Shop' };
  });
  check('19. a file that is not a backup is refused and changes nothing',
    !!results.rubbish.threw && results.rubbish.shopIntact, JSON.stringify(results.rubbish));

  /* ---- 20,21. the reports ---- */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.evaluate(helpers);
  results.reports = await page.evaluate(() => {
    /* nothing survived the deliberate old-book restore above, so build a small
       case again and look at what the two documents print */
    return (async () => {
      localStorage.clear();
      db = shapeDb(JSON.parse(JSON.stringify(DEFAULT)));
      db.customers.c1 = { id: 'c1', name: 'Dale Hansen' };
      db.vehicles.v1 = { id: 'v1', customerId: 'c1', year: '2018', make: 'BMW', model: 'M3', vin: 'X', plate: 'P' };
      editOrder(null, { customerId: 'c1', vehicleId: 'v1' });
      const o = cur;
      const d = addDamage(o, 'LF door', 'Scratch', 'Light', 'below the handle', 'Zack');
      const dmgShown = await attAdd(asFile(await makePng(40, 30, '#c33'), 'dmg-shown.png'), 'damage', d.id, {});
      dmgShown.custVisible = true; dmgShown.caption = 'Scratch as received';
      const dmgHidden = await attAdd(asFile(await makePng(40, 30, '#333'), 'dmg-hidden.png'), 'damage', d.id, {});
      dmgHidden.custVisible = false; dmgHidden.caption = 'INTERNALONLYMARKER';

      const insp = newInspection(o.id, 'v1');
      insp.tech = 'Marco';
      const key = 'tires.tire.RR';
      setInspState(insp, key, 'Urgent');
      inspItem(insp, key).custNote = 'Right rear is down to 3/32.';
      inspItem(insp, key).note = 'INTERNALNOTEMARKER';
      const shown = await attAdd(asFile(await makePng(60, 40, '#0a0'), 'tyre-shown.png'), 'insp', insp.id + '|' + key, {});
      shown.custVisible = true; shown.caption = 'CUSTOMERPHOTOMARKER';
      const hidden = await attAdd(asFile(await makePng(60, 40, '#00a'), 'tyre-hidden.png'), 'insp', insp.id + '|' + key, {});
      hidden.custVisible = false; hidden.caption = 'HIDDENPHOTOMARKER';
      completeInspection(insp, 'Marco');
      saveOrder();

      const inspHtml = docInspection(insp);
      const condHtml = docCheckin(db.orders[o.id]);
      return {
        inspShowsCustomerPhoto: inspHtml.indexOf('CUSTOMERPHOTOMARKER') >= 0,
        inspHidesInternalPhoto: inspHtml.indexOf('HIDDENPHOTOMARKER') < 0,
        inspHidesInternalNote: inspHtml.indexOf('INTERNALNOTEMARKER') < 0,
        inspHasImage: /<img src="data:image\/jpeg;base64,/.test(inspHtml),
        condShowsDamagePhoto: condHtml.indexOf('Scratch as received') >= 0,
        condHidesInternalPhoto: condHtml.indexOf('INTERNALONLYMARKER') < 0,
        condHasImage: /<img src="data:image\/jpeg;base64,/.test(condHtml),
        /* the heading must not print with nothing under it */
        condNoEmptyHeading: condHtml.indexOf('Reported by the customer') < 0,
        condWithContent: (() => {
          const o2 = db.orders[o.id]; o2.checkin.drivability = 'Pulls left under braking';
          return docCheckin(o2).indexOf('Reported by the customer') >= 0;
        })()
      };
    })();
  });
  const Rp = results.reports;
  check('20. the customer report shows their photographs and none of the shop\'s',
    Rp.inspShowsCustomerPhoto && Rp.inspHidesInternalPhoto && Rp.inspHidesInternalNote && Rp.inspHasImage,
    JSON.stringify(Rp));
  check('21. the condition report shows customer-visible damage photographs only',
    Rp.condShowsDamagePhoto && Rp.condHidesInternalPhoto && Rp.condHasImage, JSON.stringify(Rp));
  check('22. the condition report prints no heading it has nothing to put under',
    Rp.condNoEmptyHeading && Rp.condWithContent, JSON.stringify(Rp));

  check('23. nothing threw during any of it', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(JSON.stringify(results, null, 1).slice(0, 6000));
  console.log('');
  Object.keys(results).filter(k => typeof results[k] === 'string').forEach(k => console.log(' ' + results[k].padEnd(6) + ' ' + k));
  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nALL ATTACHMENT CHECKS PASSED');
})();
