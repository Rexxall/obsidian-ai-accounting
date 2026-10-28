const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
const module_={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(__dirname+'/../src/services/planning.ts','utf8'),{loader:'ts',format:'cjs'}).code,{module:module_,exports:module_.exports});
const P=module_.exports;
test('budgets: one per line, amount last, total line, junk ignored',()=>{
 const b=P.parseBudgets('总计 150,000\n餐饮 / 外食 40000\n交通：12000\n没有金额\n娱乐 0');
 assert.equal(b.total,150000);assert.deepEqual({...b.categories},{'餐饮':40000,'交通':12000});
});
test('budget usage counts only this month and the primary category',()=>{
 const tx=[{date:'2026-10-03',category:'餐饮 / 外食',baseAmount:30000},{date:'2026-10-20',category:'餐饮>超市',baseAmount:15000},{date:'2026-09-30',category:'餐饮',baseAmount:99999},{date:'2026-10-21',category:'交通',baseAmount:1000}];
 const u=P.budgetUsage(tx,'2026-10',P.parseBudgets('总计 100000\n餐饮 40000\n交通 12000'));
 assert.equal(u.rows[0].category,'餐饮');assert.equal(u.rows[0].spent,45000);assert.ok(u.rows[0].ratio>1);
 assert.equal(u.total.spent,46000);
});
test('recurring: clamped day, stable ID per month, skipped when already in the ledger',()=>{
 const rent={id:'rent',description:'房租',category:'住房',amount:65000,currency:'JPY',paymentMethod:'',day:31,enabled:true};
 const off={...rent,id:'gym',enabled:false};
 const drafts=P.recurringDrafts([rent,off],'2026-02',new Set());
 assert.equal(drafts.length,1);assert.equal(drafts[0].date,'2026-02-28');assert.equal(drafts[0].id,'rec-rent-2026-02');assert.equal(drafts[0].paymentMethod,'未分类');
 assert.equal(P.recurringDrafts([rent],'2026-02',new Set(['rec-rent-2026-02'])).length,0);
});
