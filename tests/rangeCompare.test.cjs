const {test}=require('node:test'),assert=require('node:assert/strict');
const R=require('./load.cjs').load('src/services/rangeCompare.ts');
const plain=v=>JSON.parse(JSON.stringify(v));
const pts=[{key:'2026-11-01',value:1200},{key:'2026-11-02',value:0},{key:'2026-11-03',value:3400}];
test('A to B: values, difference, percentage and the total in between, in either pick order',()=>{
 const c=R.compareRange(pts,0,2);
 assert.deepEqual(plain(c),{from:pts[0],to:pts[2],delta:2200,pct:2200/1200*100,sum:4600,count:3});
 assert.deepEqual(plain(R.compareRange(pts,2,0)),plain(c));
});
test('one day picked twice compares it with itself',()=>{
 assert.deepEqual(plain(R.compareRange(pts,1,1)),{from:pts[1],to:pts[1],delta:0,pct:null,sum:0,count:1});
});
test('from 0 there is no percentage; to 0 is −100%',()=>{
 assert.equal(R.compareRange(pts,1,2).pct,null);
 assert.equal(R.compareRange(pts,0,1).pct,-100);
});
test('refunds can make a day negative; the percentage is against its size',()=>{
 const c=R.compareRange([{key:'a',value:-200},{key:'b',value:100}],0,1);
 assert.equal(c.delta,300);assert.equal(c.pct,150);
});
test('indexes outside the series give nothing',()=>{
 assert.equal(R.compareRange(pts,-1,2),null);assert.equal(R.compareRange(pts,0,3),null);assert.equal(R.compareRange([],0,0),null);assert.equal(R.compareRange(pts,0.5,1),null);
});
test('daily series covers every day of the month, February in a leap year included',()=>{
 const d=R.dailySeries('2028-02',{'2028-02-29':5,'2028-03-01':9});
 assert.equal(d.length,29);assert.equal(d[28].value,5);assert.equal(d[0].value,0);
 assert.deepEqual(plain(R.dailySeries('bad',{})),[]);
 assert.equal(R.dailySeries('2026-11',{},'2026-11-16').length,16,'the current month stops at today');
 assert.equal(R.dailySeries('2026-10',{},'2026-11-16').length,31,'a past month shows every day');
});
test('monthly series fills gaps across a year end',()=>{
 const m=R.monthlySeries({'2025-11':10,'2026-02':40,'noise':1});
 assert.deepEqual(plain(m.map(p=>[p.key,p.value])),[['2025-11',10],['2025-12',0],['2026-01',0],['2026-02',40]]);
 assert.equal(R.monthlySeries({}).length,0);
 assert.equal(R.monthlySeries({'2026-05':1}).length,1);
 assert.equal(R.monthlySeries({'1026-01':1,'2026-01':1}).length,1200,'a mistyped year stops instead of freezing');
});
test('percentages read like a person wrote them',()=>{
 assert.equal(R.formatPct(183.333),'+183.3%');assert.equal(R.formatPct(-6.25),'−6.3%');assert.equal(R.formatPct(0),'0.0%');assert.equal(R.formatPct(12345.6),'+12,346%');
});
test('tens of thousands of bars stay fast',()=>{
 const many=Array.from({length:50000},(_,i)=>({key:String(i),value:i%7}));
 const t=Date.now();const c=R.compareRange(many,0,49999);
 assert.ok(Date.now()-t<50);assert.equal(c.count,50000);
});
