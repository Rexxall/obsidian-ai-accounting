const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
function load(requestUrl){const module={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(__dirname+'/../src/services/FXService.ts','utf8'),{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,console:{log(){},warn(){},error(){}},Date,Map,JSON,Object,require:name=>name==='obsidian'?{requestUrl}:undefined});return module.exports;}
const app={vault:{adapter:{exists:async()=>false,read:async()=>'',write:async()=>{}}}};
test('offline with no cached rate: a clear error the caller can show',async()=>{
 const {FXService,RateUnavailableError}=load(async()=>{throw new Error('net::ERR_INTERNET_DISCONNECTED');});
 const fx=new FXService(app,'p');
 await assert.rejects(fx.convert(65000,'JPY','CNY','2026-10-01'),e=>e instanceof RateUnavailableError&&e.message==='取不到汇率，请稍后重试或手动填写。');
 assert.equal(await fx.convert(10,'JPY','JPY','2026-10-01'),10);
});
test('offline with a rate cached earlier: the cached rate is used',async()=>{
 let online=true;
 const {FXService}=load(async()=>{if(!online)throw new Error('offline');return {status:200,json:{rates:{CNY:0.047}}};});
 const fx=new FXService(app,'p');
 assert.equal(await fx.getExchangeRate('JPY','CNY','2026-10-01'),0.047);
 online=false;
 assert.equal(await fx.getExchangeRate('JPY','CNY','2026-10-01'),0.047);
});
