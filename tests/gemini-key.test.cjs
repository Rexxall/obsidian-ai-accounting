// The AI requests go through rex-ai-kit with keys read from the Keychain at call time.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./load.cjs');
const reply=JSON.stringify({transactions:[{date:'2026-10-21',description:'Coffee',amount:500,currency:'JPY'}]});
const ok={status:200,json:{choices:[{message:{content:reply}}]},text:JSON.stringify({choices:[{message:{content:reply}}]})};
const gem={status:200,text:JSON.stringify({candidates:[{content:{parts:[{text:reply}]}}]})};
const settings=(svcs)=>({defaultInputCurrency:'JPY',aiServices:svcs});
const svc=(ai,o)=>({id:'1',name:'',enabled:true,vision:true,ai:{provider:'custom',model:'m',baseUrl:'https://example.test/v1',...ai},...o});
function setup(requestUrl,keys={}){
 const M=load('tests/ai-entry.ts',{requestUrl,Platform:{isDesktopApp:false}});
 const client=M.createAiClient({getSecret:n=>keys[n]??null},undefined);
 return {...M,client};
}
test('Gemini keeps the key in a header, never in the URL',async()=>{
 let seen;const {AIService,client}=setup(async req=>{seen=req;return gem;},{'gemini-api-key':'TEST-KEY-123'});
 const rows=await new AIService(settings([svc({provider:'gemini',baseUrl:undefined,model:'gemini-3.8-flash'})]),client).processInput('Coffee 500 yen');
 assert.ok(!seen.url.includes('TEST-KEY-123'));assert.ok(!seen.url.includes('key='));assert.equal(seen.headers['x-goog-api-key'],'TEST-KEY-123');
 assert.equal(rows.length,1);assert.equal(rows[0].amount,500);
});
test('an old Keychain name kept on the slot is read; OpenAI-compatible services get a Bearer header',async()=>{
 let seen;const {AIService,client}=setup(async req=>{seen=req;return ok;},{'ai-accounting-endpoint-1':'SECRET-E'});
 await new AIService(settings([svc({secretName:'ai-accounting-endpoint-1'})]),client).processInput('x');
 assert.equal(seen.headers.Authorization,'Bearer SECRET-E');assert.equal(seen.url,'https://example.test/v1/chat/completions');
});
test('OpenAI and Anthropic use their own APIs with the shared key names',async()=>{
 const seen=[];const anth={status:200,text:JSON.stringify({content:[{type:'text',text:reply}]})};
 const {AIService,client}=setup(async req=>{seen.push(req);return req.url.includes('anthropic')?anth:ok;},{'openai-api-key':'O-KEY','anthropic-api-key':'A-KEY'});
 await new AIService(settings([svc({provider:'openai',baseUrl:undefined,model:'gpt-6-luna'})]),client).processInput('x');
 await new AIService(settings([svc({provider:'anthropic',baseUrl:undefined,model:'claude-haiku-5-5'})]),client).processInput('x');
 assert.equal(seen[0].url,'https://api.openai.com/v1/chat/completions');assert.equal(seen[0].headers.Authorization,'Bearer O-KEY');
 assert.equal(seen[1].url,'https://api.anthropic.com/v1/messages');assert.equal(seen[1].headers['x-api-key'],'A-KEY');
});
test('a failed service hands over to the next; an image skips services that cannot read images and local programs',async()=>{
 const urls=[];const {AIService,client}=setup(async req=>{urls.push(req.url);return req.url.includes('first')?{status:500,text:'boom'}:ok;},{'custom-ai-api-key':'k'});
 const s=settings([svc({baseUrl:'https://first.test/v1'},{id:'a'}),svc({baseUrl:'https://textonly.test/v1'},{id:'b',vision:false}),svc({provider:'claude-code',baseUrl:undefined,model:'haiku'},{id:'l',vision:true}),svc({baseUrl:'https://second.test/v1'},{id:'c'})]);
 const rows=await new AIService(s,client).processInput('',[{data:'aGVsbG8=',mimeType:'image/png'}]);
 assert.equal(rows.length,1);assert.deepEqual(urls,['https://first.test/v1/chat/completions','https://second.test/v1/chat/completions']);
});
test('no service set up, or none reads images: a clear message, nothing sent',async()=>{
 let calls=0;const {AIService,failureMessage,client}=setup(async()=>{calls++;return ok;});
 await assert.rejects(new AIService(settings([]),client).processInput('x'),e=>failureMessage(e).includes('还没有设置 AI 服务'));
 await assert.rejects(new AIService(settings([svc({},{vision:false})]),client).processInput('x',[{data:'aGVsbG8=',mimeType:'image/png'}]),e=>failureMessage(e).includes('没有能识图'));
 assert.equal(calls,0);
});
test('every failure names the service and the next step',async()=>{
 const {AIService,failureMessage,client}=setup(async()=>({status:402,text:JSON.stringify({error:{message:'Insufficient Balance'}})}),{'deepseek-api-key':'k'});
 const err=await new AIService(settings([svc({provider:'deepseek',baseUrl:undefined,model:'deepseek-flash'})]),client).processInput('x').catch(e=>e);
 assert.equal(failureMessage(err),'DeepSeek：余额或额度不足。去服务商后台充值，或换一家服务商。服务商原话：Insufficient Balance');
 const nokey=await new AIService(settings([svc({provider:'openai',baseUrl:undefined,model:'gpt-6-luna'})]),client).processInput('x').catch(e=>e);
 assert.match(failureMessage(nokey),/^OpenAI：还没选密钥/);
});
test('a note with embedded receipts sends its text and every image, to OpenAI-compatible and Gemini services alike',async()=>{
 const seen=[];const {AIService,client}=setup(async req=>{seen.push(req);return req.url.includes('generativelanguage')?gem:ok;},{'custom-ai-api-key':'k','gemini-api-key':'g'});
 const images=[{data:'AAAA',mimeType:'image/png'},{data:'BBBB',mimeType:'image/jpeg'}];
 await new AIService(settings([svc({})]),client).processInput('Lunch with A\n![[r1.png]]\n![[r2.jpg]]',images);
 const content=JSON.parse(seen[0].body).messages[0].content;
 assert.deepEqual(content.filter(p=>p.type==='image_url').map(p=>p.image_url.url),['data:image/png;base64,AAAA','data:image/jpeg;base64,BBBB']);
 assert.ok(content[0].text.includes('Lunch with A'));assert.ok(content[0].text.includes('attached images'));
 await new AIService(settings([svc({provider:'gemini',baseUrl:undefined,model:'g'})]),client).processInput('',images);
 const parts=JSON.parse(seen[1].body).contents[0].parts;
 assert.deepEqual(parts.filter(p=>p.inline_data).map(p=>p.inline_data.data),['AAAA','BBBB']);
});
test('replies wrapped in an object, or bare arrays, both read',()=>{
 const {parseJsonArray}=load('src/services/AIService.ts',{Platform:{isDesktopApp:false}});
 assert.equal(parseJsonArray('```json\n{"transactions":[{"a":1},{"a":2}]}\n```').length,2);
 assert.equal(parseJsonArray('[{"a":1}]').length,1);
 assert.throws(()=>parseJsonArray('not json'),e=>e.kind==='bad-response');
});
