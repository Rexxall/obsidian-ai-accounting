const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./load.cjs');
const ok={status:200,json:{choices:[{message:{content:'[{"date":"2026-10-21","description":"Coffee","amount":500,"currency":"JPY"}]'}}]},text:''};
const settings=(eps)=>({defaultInputCurrency:'JPY',apiEndpoints:eps});
const ep=(o)=>({id:'1',name:'A',provider:'custom',endpoint:'https://example.test/v1',apiKey:'',apiKeySecret:'k',model:'m',enabled:true,vision:true,...o});
test('Gemini keeps the key in a header, never in the URL',async()=>{
 let seen;const {AIService}=load('src/services/AIService.ts',{requestUrl:async req=>{seen=req;return {status:200,json:{candidates:[{content:{parts:[{text:'[{"date":"2026-10-21","description":"Coffee","amount":500,"currency":"JPY"}]'}]}}]}};}});
 const rows=await new AIService(settings([ep({provider:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-2.5-flash'})]),()=>'TEST-KEY-123').processInput('Coffee 500 yen');
 assert.ok(!seen.url.includes('TEST-KEY-123'));assert.ok(!seen.url.includes('key='));assert.equal(seen.headers['x-goog-api-key'],'TEST-KEY-123');
 assert.equal(rows.length,1);assert.equal(rows[0].amount,500);
});
test('keys come from secret storage by name; OpenAI-compatible services get a Bearer header',async()=>{
 let seen;const {AIService}=load('src/services/AIService.ts',{requestUrl:async req=>{seen=req;return ok;}});
 await new AIService(settings([ep({})]),n=>n==='k'?'SECRET-E':'').processInput('x');
 assert.equal(seen.headers.Authorization,'Bearer SECRET-E');assert.equal(seen.url,'https://example.test/v1/chat/completions');
});
test('a failed service hands over to the next; an image skips services that cannot read images',async()=>{
 const urls=[];const {AIService}=load('src/services/AIService.ts',{requestUrl:async req=>{urls.push(req.url);return req.url.includes('first')?{status:500,text:'boom',json:{}}:ok;}});
 const s=settings([ep({id:'a',endpoint:'https://first.test/v1'}),ep({id:'b',endpoint:'https://textonly.test/v1',vision:false}),ep({id:'c',endpoint:'https://second.test/v1'})]);
 const rows=await new AIService(s,()=>'k').processInput('aGVsbG8=',true,'image/png');
 assert.equal(rows.length,1);assert.deepEqual(urls,['https://first.test/v1/chat/completions','https://second.test/v1/chat/completions']);
});
test('no service set up, or none reads images: a clear message, nothing sent',async()=>{
 let calls=0;const {AIService,failureMessage}=load('src/services/AIService.ts',{requestUrl:async()=>{calls++;return ok;}});
 await assert.rejects(new AIService(settings([]),()=>'').processInput('x'),e=>failureMessage(e).includes('还没有设置 AI 服务'));
 await assert.rejects(new AIService(settings([ep({vision:false})]),()=>'k').processInput('x',true),e=>failureMessage(e).includes('没有能识图'));
 assert.equal(calls,0);
});
