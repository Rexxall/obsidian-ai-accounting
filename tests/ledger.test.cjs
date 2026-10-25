const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esbuild=require('esbuild'),crypto=require('node:crypto').webcrypto;
class TFile{constructor(path){this.path=path;this.basename=path.split('/').pop().replace(/\.md$/,'');this.extension='md';this.stat={mtime:1};}}
class TFolder{constructor(){this.children=[];}}
function load(file,extra={}){const module={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(__dirname+'/../'+file,'utf8'),{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,crypto,console,require:name=>name==='obsidian'?{TFile,TFolder,Notice:class{}}:extra[name]});return module.exports;}
const ledger=load('src/services/ledger.ts');
const {DataService}=load('src/services/DataService.ts',{'./ledger':ledger});
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
