const {test}=require('node:test'),assert=require('node:assert/strict');

class TFile{constructor(path){this.path=path;this.basename=path.split('/').pop().replace(/\.md$/,'');this.extension='md';this.stat={mtime:1};}}
class TFolder{constructor(){this.children=[];}}
const {load}=require('./load.cjs');
const ledger=load('src/services/ledger.ts');
const {DataService}=load('src/services/DataService.ts',{TFile,TFolder});
function fixture(initial=''){
 const files=new Map(),contents=new Map(),metadata={};const file=new TFile('Finance/2026-09.md');files.set(file.path,file);contents.set(file.path,initial);
 const app={vault:{getAbstractFileByPath:p=>files.get(p),read:async f=>contents.get(f.path),createFolder:async()=>{},create:async(p,s)=>{const f=new TFile(p);files.set(p,f);contents.set(p,s);return f;},process:async(f,fn)=>{contents.set(f.path,fn(contents.get(f.path)));f.stat.mtime++;}},fileManager:{processFrontMatter:async(f,fn)=>{fn(metadata);}}};
 return {service:new DataService(app,{financeFolderPath:'Finance',baseCurrency:'JPY',users:[]}),file,contents,metadata};
}
const tx={date:'2026-09-19',description:'Coffee',category:'Food',amount:500,currency:'JPY',rate:1,baseAmount:500,paymentMethod:'Cash'};
test('table preserves blanks, pipes, newlines and literal entities',()=>{
 const source={...tx,description:'',category:'a|b\nc &amp;',id:'fixed'};
 const cells=ledger.tableCells(ledger.renderTransaction(source));assert.equal(cells[1],'');assert.equal(cells[2],source.category);assert.equal(cells[3],'500.00');
});
test('real equal purchases survive; retry ID is idempotent',async()=>{
 const {service,file,metadata}=fixture();await service.appendBatchToMonthlyReport('2026-09',[{...tx,id:'first'},{...tx,id:'second'}]);
 await service.appendBatchToMonthlyReport('2026-09',[{...tx,id:'first'}]);const result=await service.parseMonthlyFile(file);
 assert.equal(result.transactions.length,2);assert.equal(result.total,1000);assert.equal(metadata.total_expense,1000);
});
test('blank descriptions survive; edit identifies the second identical legacy row',async()=>{
 const raw='| 2026-09-19 |  | Food | 500.00 | JPY | 1 | 500.00 | Cash |';const {service,file}=fixture(raw+'\n'+raw+'\n');
 const initial=await service.parseMonthlyFile(file);assert.equal(initial.transactions.length,2);
 await service.updateTransaction(initial.transactions[1],{...initial.transactions[1],description:'Second'});
 const next=await service.parseMonthlyFile(file);assert.equal(next.transactions[0].description,'');assert.equal(next.transactions[1].description,'Second');
});
test('stale delete is blocked; fresh delete recomputes totals',async()=>{
 const {service,file,contents,metadata}=fixture(ledger.renderTransaction({...tx,id:'one'})+'\n');const original=(await service.parseMonthlyFile(file)).transactions[0];
 await service.updateTransaction(original,{...original,amount:600,baseAmount:600});await assert.rejects(service.deleteTransaction(original));assert.match(contents.get(file.path),/600\.00/);
 const changed=(await service.parseMonthlyFile(file)).transactions[0];await service.deleteTransaction(changed);assert.equal(metadata.total_expense,0);assert.equal(metadata.transaction_count,0);
});
test('invalid data and cross-month edits fail without writing',async()=>{
 assert.throws(()=>ledger.validateTransaction({...tx,date:'2026-02-30'}));assert.throws(()=>ledger.validateTransaction({...tx,amount:NaN}));
 const {service,file,contents}=fixture(ledger.renderTransaction({...tx,id:'one'}));const old=(await service.parseMonthlyFile(file)).transactions[0];const before=contents.get(file.path);
 await assert.rejects(service.updateTransaction(old,{...old,date:'2026-10-01'}));assert.equal(contents.get(file.path),before);
});
test('transfers are listed but not counted as spending; refunds subtract',async()=>{
 const tx=(o)=>ledger.renderTransaction({date:'2026-09-01',description:'x',category:'餐饮美食 / 午餐',amount:1000,currency:'JPY',rate:1,baseAmount:1000,...o});
 const {service,file}=fixture([tx({}),tx({category:'转账 / 充值',amount:5000,baseAmount:5000}),tx({category:'购物消费 / 日用品',amount:-300,baseAmount:-300})].join('\n')+'\n');
 const stats=await service.parseMonthlyFile(file);
 assert.equal(stats.transactions.length,3);assert.equal(stats.total,700);
 assert.deepEqual(JSON.parse(JSON.stringify(stats.transactions.map(ledger.entryKind))),['expense','transfer','refund']);
 assert.equal(ledger.entryKind({category:'转账服务费 / x',amount:1}),'expense','only the exact top-level name counts as a transfer');
 assert.equal(ledger.entryKind({category:'Transfer / IC card',amount:1}),'transfer');assert.equal(ledger.entryKind({category:'Transfers',amount:1}),'transfer');
});
