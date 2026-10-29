const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./load.cjs');
const P=load('src/ai/providers.ts');
test('errors are told apart: key, quota, rate, model, other',()=>{
 assert.equal(P.classify(401,'Authentication Fails'),'auth');
 assert.equal(P.classify(402,'Insufficient Balance'),'quota');
 assert.equal(P.classify(429,'You exceeded your current quota'),'quota');
 assert.equal(P.classify(429,'Rate limit reached'),'rate');
 assert.equal(P.classify(403,'Arrearage: account is overdue'),'quota');
 assert.equal(P.classify(404,''),'model');
 assert.equal(P.classify(400,'Model Not Exist'),'model');
 assert.equal(P.classify(400,'API key not valid. Please pass a valid API key.'),'auth');
 assert.equal(P.classify(500,'oops'),'http');
});
test('diagnostics never carry a key',()=>{
 const out=P.redact('Bearer sk-abcdefghijklmnop failed for key AIzaSyA1234567890123456789012 and MYSECRET123 ?key=zzz',['MYSECRET123']);
 assert.ok(!/sk-abcdef|AIzaSy|MYSECRET123|key=zzz/.test(out),out);
});
test('services are recognised from saved addresses',()=>{
 assert.equal(P.guessProvider('https://api.deepseek.com/v1'),'deepseek');
 assert.equal(P.guessProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'),'qwen');
 assert.equal(P.guessProvider('https://api.siliconflow.cn/v1'),'siliconflow');
 assert.equal(P.guessProvider('https://api.moonshot.cn/v1'),'kimi');
 assert.equal(P.guessProvider('https://open.bigmodel.cn/api/paas/v4'),'zhipu');
 assert.equal(P.guessProvider('http://localhost:2048/v1'),'custom');
});
function withNet(handler){return load('src/ai/providers.ts',{requestUrl:handler});}
test('test connection: no key stops before any request',async()=>{
 let calls=0;const T=withNet(async()=>{calls++;});
 const r=await T.testConnection({provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:''},'test');
 assert.equal(r.ok,false);assert.match(r.message,/还没有填 API 密钥/);assert.equal(calls,0);
});
test('test connection: a model missing from the list is reported without a paid request',async()=>{
 const urls=[];const T=withNet(async req=>{urls.push(req.url);return {status:200,json:{data:[{id:'deepseek-flash'}]},text:''};});
 const r=await T.testConnection({provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'nope',apiKey:'sk-test-000000'},'test');
 assert.equal(r.ok,false);assert.match(r.message,/模型不存在/);assert.deepEqual(urls,['https://api.deepseek.com/models']);
 assert.ok(!r.diagnostics.includes('sk-test-000000'));
});
test('test connection: out of balance and timeout',async()=>{
 const Q=withNet(async req=>req.url.endsWith('/models')?{status:200,json:{data:[{id:'m'}]},text:''}:{status:402,json:{},text:'Insufficient Balance'});
 assert.match((await Q.testConnection({provider:'deepseek',baseUrl:'https://x.test',model:'m',apiKey:'k'},'t')).message,/余额或额度不足/);
 const T=load('src/ai/providers.ts',{requestUrl:()=>new Promise(()=>{})},{window:{setTimeout:(f)=>setTimeout(f,5),clearTimeout}});
 assert.match((await T.testConnection({provider:'deepseek',baseUrl:'https://x.test',model:'m',apiKey:'k'},'t')).message,/没有回复/);
});
test('test connection: works end to end',async()=>{
 const T=withNet(async req=>req.url.endsWith('/models')?{status:200,json:{data:[{id:'m'}]},text:''}:{status:200,json:{choices:[{message:{content:'ok'}}]},text:''});
 const r=await T.testConnection({provider:'kimi',baseUrl:'https://api.moonshot.cn/v1',model:'m',apiKey:'k'},'t');
 assert.equal(r.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(r.models)),['m']);
});
