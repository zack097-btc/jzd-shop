/* The test that the old Shop Manager did not have, and that would have caught
   the loss of two hours of catalogue.
   1. Work entered is still there after a restart.
   2. A store that cannot be READ is never silently replaced with an empty shop
      and is never written over — that is how a hiding problem became a
      permanent one.
   3. A write that does not land is reported, not swallowed. */
const { chromium } = require('playwright');
(async()=>{
const b=await chromium.launch(); const p=await b.newPage();
const dialogs=[]; p.on('dialog',d=>{dialogs.push(d.message().slice(0,80));d.accept();});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERR: '+e.message));
const url='file://'+process.cwd()+'/index.html';
const out={};

await p.goto(url,{waitUntil:'load'}); await p.waitForTimeout(400);

// --- 1. enter work the way the shop does, then restart -----------------
await p.evaluate(()=>{
  db.customers["c1"]={id:"c1",name:"Hansen Marine",phone:"555-0101"};
  db.vehicles["v1"]={id:"v1",customerId:"c1",year:"2019",make:"Ford",model:"F-250"};
  db.catalog.labor["l1"]={id:"l1",desc:"Diagnostic hour",hours:"1",rate:"120"};
  db.catalog.parts["p1"]={id:"p1",name:"Oil filter",price:"14.50"};
  save();
});
await p.waitForTimeout(600);
out.indicatorAfterSave = await p.textContent('#saveState');

await p.reload({waitUntil:'load'}); await p.waitForTimeout(600);
out.survivedRestart = await p.evaluate(()=>({
  customers:Object.keys(db.customers).length,
  vehicles:Object.keys(db.vehicles).length,
  labor:Object.keys(db.catalog.labor).length,
  parts:Object.keys(db.catalog.parts).length,
  laborDesc:(db.catalog.labor.l1||{}).desc,
  partName:(db.catalog.parts.p1||{}).name
}));

// --- 2. a store that cannot be read ------------------------------------
const good = await p.evaluate(()=>localStorage.getItem("jzd.shop.db"));
out.storedBytes = good.length;
await p.evaluate(()=>localStorage.setItem("jzd.shop.db","{not valid json"));
await p.reload({waitUntil:'load'}); await p.waitForTimeout(600);

out.lockedOnCorrupt = await p.evaluate(()=>!!storageLocked);
out.alarmShown = await p.evaluate(()=>document.body.innerText.includes("could not be read"));
out.indicatorWhenLocked = await p.textContent('#saveState');

// the killer: an edit while locked must NOT overwrite what is still on disk
await p.evaluate(()=>{ db.customers["cX"]={id:"cX",name:"Should never be written"}; save(); });
await p.waitForTimeout(600);
out.rawAfterEditWhileLocked = await p.evaluate(()=>localStorage.getItem("jzd.shop.db"));
out.corruptStoreLeftAlone = out.rawAfterEditWhileLocked === "{not valid json";

// --- 3. put the good book back and confirm recovery --------------------
await p.evaluate(g=>localStorage.setItem("jzd.shop.db",g), good);
await p.reload({waitUntil:'load'}); await p.waitForTimeout(600);
out.recovered = await p.evaluate(()=>({
  locked:!!storageLocked,
  labor:Object.keys(db.catalog.labor).length,
  parts:Object.keys(db.catalog.parts).length
}));

// --- 4. a write that cannot land must be reported ----------------------
await p.evaluate(()=>{
  window.__origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k,v)=>{ if(k==="jzd.shop.db") return; return window.__origSet(k,v); };
});
const before = dialogs.length;
await p.evaluate(()=>{ db.customers["c2"]={id:"c2",name:"Silent failure check"}; save(); });
await p.waitForTimeout(700);
out.failedWriteRaised = dialogs.length > before;
out.failedWriteMsg = dialogs[dialogs.length-1] || "";
out.indicatorAfterFail = await p.textContent('#saveState');

out.errors = errs;
console.log(JSON.stringify(out,null,1));

const s=out.survivedRestart;
const pass =
  s.customers===1 && s.vehicles===1 && s.labor===1 && s.parts===1 &&
  s.laborDesc==="Diagnostic hour" && s.partName==="Oil filter" &&
  out.lockedOnCorrupt && out.alarmShown && out.corruptStoreLeftAlone &&
  /NOT SAVING/.test(out.indicatorWhenLocked) &&
  !out.recovered.locked && out.recovered.labor===1 && out.recovered.parts===1 &&
  out.failedWriteRaised && /NOT SAVED/.test(out.failedWriteMsg) &&
  errs.length===0;
console.log(pass ? "ALL PERSISTENCE CHECKS PASSED" : "FAIL");
await b.close(); process.exit(pass?0:1);
})();
