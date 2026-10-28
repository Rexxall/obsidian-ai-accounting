const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
function load(requestUrl){const module={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(__dirname+'/../src/services/AIService.ts','utf8'),{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,console:{log(){},warn(){},error(){}},require:name=>name==='obsidian'?{requestUrl,Notice:class{}}:undefined});return module.exports;}
test('Gemini request keeps the key out of the URL',async()=>{
 let seen;const {AIService}=load(async req=>{seen=req;return {status:200,json:{candidates:[{content:{parts:[{text:'[{"date":"2026-10-21","description":"Coffee","amount":500,"currency":"JPY"}]'}]}}]}};});
 const service=new AIService({aiProvider:'gemini',geminiApiKey:'TEST-KEY-123',geminiModel:'gemini-2.5-flash',defaultInputCurrency:'JPY'});
 const rows=await service.processInput('Coffee 500 yen');
 assert.ok(!seen.url.includes('TEST-KEY-123'));assert.ok(!seen.url.includes('key='));
 assert.equal(seen.headers['x-goog-api-key'],'TEST-KEY-123');
 assert.equal(rows.length,1);assert.equal(rows[0].amount,500);
});
test('keys are read from secret storage by name',async()=>{
 const seen=[];const {AIService}=load(async req=>{seen.push(req);return {status:200,json:{choices:[{message:{content:'[]'}}]}};});
 const secrets={'gemini-api-key':'SECRET-G','ep-key':'SECRET-E'};
 const g=new AIService({aiProvider:'gemini',geminiSecretName:'gemini-api-key',geminiApiKey:'',geminiModel:'gemini-2.5-flash',defaultInputCurrency:'JPY'},n=>secrets[n]||'');
 await g.processInput('x');assert.equal(seen[0].headers['x-goog-api-key'],'SECRET-G');
 const o=new AIService({aiProvider:'openai',apiEndpoints:[{id:'1',name:'A',endpoint:'https://example.test/v1',apiKey:'',apiKeySecret:'ep-key',model:'m',enabled:true}],defaultInputCurrency:'JPY'},n=>secrets[n]||'');
 await o.processInput('x');assert.equal(seen[1].headers.Authorization,'Bearer SECRET-E');
});
