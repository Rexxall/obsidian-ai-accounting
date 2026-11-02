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
 const rows=await new AIService(s,()=>'k').processInput('',[{data:'aGVsbG8=',mimeType:'image/png'}]);
 assert.equal(rows.length,1);assert.deepEqual(urls,['https://first.test/v1/chat/completions','https://second.test/v1/chat/completions']);
});
test('no service set up, or none reads images: a clear message, nothing sent',async()=>{
 let calls=0;const {AIService,failureMessage}=load('src/services/AIService.ts',{requestUrl:async()=>{calls++;return ok;}});
 await assert.rejects(new AIService(settings([]),()=>'').processInput('x'),e=>failureMessage(e).includes('还没有设置 AI 服务'));
 await assert.rejects(new AIService(settings([ep({vision:false})]),()=>'k').processInput('x',[{data:'aGVsbG8=',mimeType:'image/png'}]),e=>failureMessage(e).includes('没有能识图'));
 assert.equal(calls,0);
});
test('a note with embedded receipts sends its text and every image, to OpenAI-compatible and Gemini services alike',async()=>{
 const seen=[];const {AIService}=load('src/services/AIService.ts',{requestUrl:async req=>{seen.push(req);return req.url.includes('generativelanguage')?{status:200,json:{candidates:[{content:{parts:[{text:'[]'}]}}]}}:ok;}});
 const images=[{data:'AAAA',mimeType:'image/png'},{data:'BBBB',mimeType:'image/jpeg'}];
 await new AIService(settings([ep({})]),()=>'k').processInput('Lunch with A\n![[r1.png]]\n![[r2.jpg]]',images);
 const content=JSON.parse(seen[0].body).messages[0].content;
 assert.deepEqual(content.filter(p=>p.type==='image_url').map(p=>p.image_url.url),['data:image/png;base64,AAAA','data:image/jpeg;base64,BBBB']);
 assert.ok(content[0].text.includes('Lunch with A'));assert.ok(content[0].text.includes('attached images'));
 await new AIService(settings([ep({provider:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta',model:'g'})]),()=>'k').processInput('',images);
 const parts=JSON.parse(seen[1].body).contents[0].parts;
 assert.deepEqual(parts.filter(p=>p.inlineData).map(p=>p.inlineData.data),['AAAA','BBBB']);
});
