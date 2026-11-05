const {test}=require('node:test'),assert=require('node:assert/strict');
const {monthOf,monthPath,defaultLedgerNames}=require('./load.cjs').load('src/services/ledgerFiles.ts');
test('a ledger is recognised under its new name and its old bare name, nothing else',()=>{
 assert.equal(monthOf('账本 2026-01','账本 '),'2026-01');
 assert.equal(monthOf('2026-01','账本 '),'2026-01');
 assert.equal(monthOf('Ledger 2026-01','账本 '),null);
 assert.equal(monthOf('账本 2026-1','账本 '),null);
 assert.equal(monthOf('2026-05 微信支付补录','账本 '),null);
 assert.equal(monthOf('Finances','账本 '),null);
});
test('a month goes to its existing file first, old name included, and new ones get the prefix',()=>{
 const has=paths=>p=>paths.includes(p);
 assert.equal(monthPath('F','2026-01','账本 ',has([])),'F/账本 2026-01.md');
 assert.equal(monthPath('F','2026-01','账本 ',has(['F/2026-01.md'])),'F/2026-01.md');
 assert.equal(monthPath('F','2026-01','账本 ',has(['F/2026-01.md','F/账本 2026-01.md'])),'F/账本 2026-01.md');
});
test('default names follow the language at first start',()=>{
 assert.deepEqual({...defaultLedgerNames(true)},{ledger:'账本 ',archive:'账本原文 '});
 assert.deepEqual({...defaultLedgerNames(false)},{ledger:'Ledger ',archive:'Ledger sources '});
});
test('links to a renamed ledger follow it in every link style; others stay as written',()=>{
 const {rewriteLinkTargets}=require('./load.cjs').load('src/services/ledgerFiles.ts');
 const map=new Map([['Finances/2026-10','Finances/账本 2026-10'],['2026-04','账本 2026-04']]);
 const text=['[[Finances/2026-10|十月账本]]','![[Finances/2026-10]]','[[Finances/2026-10#合计]]','  - "[[Finances/2026-10|x]]"','[[2026-04]]','[[2026-10]]','[[Finances/2026-10.md]]','[月账](Finances/2026-10.md)','[月账](<Finances/2026-10.md>)','[[Finances/2026-10-01]]'].join('\n');
 assert.equal(rewriteLinkTargets(text,map),['[[Finances/账本 2026-10|十月账本]]','![[Finances/账本 2026-10]]','[[Finances/账本 2026-10#合计]]','  - "[[Finances/账本 2026-10|x]]"','[[账本 2026-04]]','[[2026-10]]','[[Finances/账本 2026-10.md]]','[月账](Finances/账本%202026-10.md)','[月账](<Finances/账本 2026-10.md>)','[[Finances/2026-10-01]]'].join('\n'));
});
