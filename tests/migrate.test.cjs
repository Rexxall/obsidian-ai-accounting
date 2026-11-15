const {test}=require('node:test'),assert=require('node:assert/strict');
const {migrateSettings,moveKeys}=require('./load.cjs').load('src/services/migrate.ts');
const plain=v=>JSON.parse(JSON.stringify(v));
const defaults={baseCurrency:'CNY',aiServices:[],drafts:[],financeFolderPath:'Finances',magicFolderPath:'Finances/Inbox',archiveFolderPath:'Finances/Archive',defaultInputCurrency:'CNY',users:[{id:'default',name:'Me',folder:'Finances',color:'#000000'}],currentUser:'default',sidebarWidth:250,dailyJournalEnabled:false,dailyJournalFolderPath:'',dailyJournalFilePattern:'YYYY-MM-DD',budgetText:'',recurring:[]};
const store=(init={})=>{const m={...init};return {m,getSecret:n=>m[n]??null,setSecret:(n,v)=>{m[n]=v;}};};
// Same shape as real 0.2.x files, every value made up.
const v021={baseCurrency:'CNY',aiProvider:'openai',geminiApiKey:'g-test',geminiModel:'gemini-2.5-flash-lite',openaiApiKey:'legacy-test',openaiModel:'model-x',openaiEndpoint:'https://legacy.example/v1',
 apiEndpoints:[{id:'1',name:'A',endpoint:'https://a.example/v1',apiKey:'a-test',model:'m',enabled:true},{id:'2',name:'B',endpoint:'https://b.example/v1',apiKey:'b-test',model:'m',enabled:true}],
 financeFolderPath:'60 - Personal/Finances',magicFolderPath:'60 - Personal/Finances/Inbox',archiveFolderPath:'60 - Personal/Finances/Archive',defaultInputCurrency:'JPY',
 users:[{id:'default',name:'Me',folder:'60 - Personal/Finances',color:'#111111'},{id:'u2',name:'Two',folder:'60 - Personal/Finances/Two',color:'#222222'}],currentUser:'default',sidebarWidth:292,dailyJournalEnabled:true,dailyJournalFolderPath:'Journal',dailyJournalFilePattern:'YYYY-MM-DD'};
const v020={...v021,aiProvider:'gemini'};delete v020.apiEndpoints;
// Same shape as the 0.8.1 file in daily use: DeepSeek with its own Keychain name, two entries on a local proxy, Gemini off.
const v081={baseCurrency:'JPY',defaultInputCurrency:'JPY',budgetText:'总计 150000',apiEndpoints:[
 {id:'1777448233608',name:'Deepseek',endpoint:'https://api.deepseek.com/v1',apiKey:'',model:'deepseek-v4-pro',enabled:true,apiKeySecret:'ai-accounting-endpoint-1777448233608',provider:'deepseek',vision:true},
 {id:'migrated-default',name:'Pro',endpoint:'http://localhost:2048/v1',apiKey:'',model:'gemini-3.1-pro-preview',enabled:true,apiKeySecret:'ai-accounting-endpoint-migrated-default',provider:'custom',vision:true},
 {id:'1776268891462',name:'Flash',endpoint:'http://localhost:2048/v1',apiKey:'',model:'gemini-3-flash-preview',enabled:true,apiKeySecret:'ai-accounting-endpoint-1776268891462',provider:'custom',vision:true},
 {id:'migrated-gemini',name:'Google Gemini',provider:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta',apiKey:'',apiKeySecret:'gemini-api-key',model:'gemini-3.1-pro-preview',enabled:false,vision:true}]};

test('0.8.1 in daily use: every service, model, order and on/off state kept; old Keychain names still used',()=>{
 const s=migrateSettings(v081,defaults);
 assert.equal('apiEndpoints' in s,false);assert.equal(s.budgetText,'总计 150000');
 assert.deepEqual(plain(s.aiServices),[
  {id:'1777448233608',name:'',enabled:true,vision:true,ai:{provider:'deepseek',model:'deepseek-v4-pro',secretName:'ai-accounting-endpoint-1777448233608'}},
  {id:'migrated-default',name:'Pro',enabled:true,vision:true,ai:{provider:'custom',model:'gemini-3.1-pro-preview',secretName:'ai-accounting-endpoint-migrated-default',baseUrl:'http://localhost:2048/v1'}},
  {id:'1776268891462',name:'Flash',enabled:true,vision:true,ai:{provider:'custom',model:'gemini-3-flash-preview',secretName:'ai-accounting-endpoint-1776268891462',baseUrl:'http://localhost:2048/v1'}},
  {id:'migrated-gemini',name:'',enabled:false,vision:true,ai:{provider:'gemini',model:'gemini-3.1-pro-preview'}}]);
 const keys=store({'ai-accounting-endpoint-1777448233608':'d','ai-accounting-endpoint-migrated-default':'p','ai-accounting-endpoint-1776268891462':'f','gemini-api-key':'g'});
 assert.equal(moveKeys(s.aiServices,keys),false,'readable names are not renamed');
 assert.equal(s.aiServices[0].ai.secretName,'ai-accounting-endpoint-1777448233608');
});
test('a saved name that holds nothing falls back to the shared key',()=>{
 const s=migrateSettings(v081,defaults);
 const keys=store({'deepseek-api-key':'shared'});
 assert.equal(moveKeys(s.aiServices,keys),true);
 assert.equal('secretName' in s.aiServices[0].ai,false);
 assert.equal(s.aiServices[1].ai.secretName,'ai-accounting-endpoint-migrated-default','a proxy has no shared key to fall back to');
});
test('migrating twice changes nothing',()=>{
 const once=migrateSettings(v081,defaults);
 assert.deepEqual(plain(migrateSettings(plain(once),defaults)),plain(once));
});
test('0.2.1 (endpoint list plus an unused single key): nothing lost, plain keys end up in the Keychain only',()=>{
 const s=migrateSettings(v021,defaults);
 assert.equal(s.financeFolderPath,'60 - Personal/Finances');assert.equal(s.users.length,2);assert.equal(s.users[1].folder,'60 - Personal/Finances/Two');
 assert.equal(s.dailyJournalEnabled,true);assert.equal(s.defaultInputCurrency,'JPY');
 for(const f of ['aiProvider','openaiApiKey','geminiApiKey','geminiModel','openaiEndpoint','apiEndpoints'])assert.equal(f in s,false,f+' is gone');
 assert.deepEqual(plain(s.aiServices.map(e=>[e.id,e.name,e.enabled,e.ai.provider,e.ai.baseUrl||''])),[['1','A',true,'custom','https://a.example/v1'],['2','B',true,'custom','https://b.example/v1'],['migrated-legacy','OpenAI',false,'custom','https://legacy.example/v1'],['migrated-gemini','',false,'gemini','']]);
 assert.equal(s.aiServices[3].ai.model,'gemini-2.5-flash-lite');
 const keys=store();
 assert.equal(moveKeys(s.aiServices,keys),true);
 assert.equal(JSON.stringify(s).includes('-test'),false,'no key left in the settings');
 assert.equal(keys.m['custom-ai-api-key'],'a-test');
 assert.equal(s.aiServices[1].ai.secretName,'ai-accounting-custom-ai-api-key','a second different key gets the plugin’s own name');
 assert.equal(keys.m['ai-accounting-custom-ai-api-key'],'b-test');
 assert.equal(keys.m['gemini-api-key'],'g-test');assert.equal('secretName' in s.aiServices[3].ai,false);
 assert.equal(v021.openaiApiKey,'legacy-test','the input is not changed');
});
test('a plain key never overwrites a different key another plugin keeps under the shared name',()=>{
 const s=migrateSettings({apiEndpoints:[{id:'o',name:'OpenAI',endpoint:'https://api.openai.com/v1',apiKey:'mine',model:'gpt-4o-mini',enabled:true}]},defaults);
 const keys=store({'openai-api-key':'theirs'});
 moveKeys(s.aiServices,keys);
 assert.equal(keys.m['openai-api-key'],'theirs');assert.equal(s.aiServices[0].ai.secretName,'ai-accounting-openai-api-key');assert.equal(keys.m['ai-accounting-openai-api-key'],'mine');
 assert.deepEqual(plain(s.aiServices[0].ai),{provider:'openai',model:'gpt-4o-mini',secretName:'ai-accounting-openai-api-key'});
});
test('0.2.0 (Gemini chosen, single OpenAI key kept): Gemini first and on, OpenAI kept off',()=>{
 const s=migrateSettings(v020,defaults);
 assert.deepEqual(plain(s.aiServices.map(e=>[e.id,e.enabled,e.ai.provider])),[['migrated-gemini',true,'gemini'],['migrated-default',false,'custom']]);
});
test('a single key that is already in the list is not added twice',()=>{
 const s=migrateSettings({...v021,openaiApiKey:'a-test'},defaults);
 assert.equal(s.aiServices.filter(e=>e.ai.provider!=='gemini').length,2);
});
test('0.5.0 shape: Gemini secret by name, DeepSeek and a local proxy in the list',()=>{
 const v050={aiProvider:'openai',geminiSecretName:'gemini-api-key',geminiApiKey:'',geminiModel:'model-g',apiEndpoints:[
  {id:'d',name:'Deepseek',endpoint:'https://api.deepseek.com/v1',apiKey:'',apiKeySecret:'ai-accounting-endpoint-d',model:'deepseek-v4-pro',enabled:true},
  {id:'p',name:'Proxy',endpoint:'http://localhost:2048/v1',apiKey:'',apiKeySecret:'ai-accounting-endpoint-p',model:'m',enabled:true}]};
 const s=migrateSettings(v050,defaults);
 assert.deepEqual(plain(s.aiServices.map(e=>[e.id,e.ai.provider,e.enabled,e.ai.secretName||''])),[['d','deepseek',true,'ai-accounting-endpoint-d'],['p','custom',true,'ai-accounting-endpoint-p'],['migrated-gemini','gemini',false,'']]);
 assert.equal(s.aiServices[0].ai.model,'deepseek-v4-pro','models the user picked are kept');
});
test('older addresses map to built-in providers: Gemini OpenAI-compatible becomes native, Ollama drops /v1',()=>{
 const s=migrateSettings({apiEndpoints:[
  {id:'g',name:'G',endpoint:'https://generativelanguage.googleapis.com/v1beta/openai/',apiKeySecret:'gemini-api-key',model:'gemini-3.8-flash',enabled:true},
  {id:'o',name:'Local',endpoint:'http://localhost:11434/v1',model:'llama3.2-vision',enabled:true,vision:false},
  {id:'k',name:'Kimi',provider:'kimi',endpoint:'https://api.moonshot.cn/v1',apiKeySecret:'ai-accounting-endpoint-k',model:'',enabled:true},
  {id:'z',name:'',provider:'zhipu',endpoint:'https://open.bigmodel.cn/api/paas/v4',model:'',enabled:true}]},defaults);
 assert.deepEqual(plain(s.aiServices.map(e=>e.ai)),[{provider:'gemini',model:'gemini-3.8-flash'},{provider:'ollama',model:'llama3.2-vision'},{provider:'kimi',model:'',secretName:'ai-accounting-endpoint-k'},{provider:'zhipu',model:'glm-5.3-flash'}]);
 assert.equal(s.aiServices[1].vision,false);
});
