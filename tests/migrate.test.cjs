const {test}=require('node:test'),assert=require('node:assert/strict');
const {migrateSettings}=require('./load.cjs').load('src/services/migrate.ts');
const defaults={baseCurrency:'CNY',apiEndpoints:[],drafts:[],financeFolderPath:'Finances',magicFolderPath:'Finances/Inbox',archiveFolderPath:'Finances/Archive',defaultInputCurrency:'CNY',users:[{id:'default',name:'Me',folder:'Finances',color:'#000000'}],currentUser:'default',sidebarWidth:250,dailyJournalEnabled:false,dailyJournalFolderPath:'',dailyJournalFilePattern:'YYYY-MM-DD',budgetText:'',recurring:[]};
// Same shape as real 0.2.x files, every value made up.
const v021={baseCurrency:'CNY',aiProvider:'openai',geminiApiKey:'g-test',geminiModel:'gemini-2.5-flash-lite',openaiApiKey:'legacy-test',openaiModel:'model-x',openaiEndpoint:'https://legacy.example/v1',
 apiEndpoints:[{id:'1',name:'A',endpoint:'https://a.example/v1',apiKey:'a-test',model:'m',enabled:true},{id:'2',name:'B',endpoint:'https://b.example/v1',apiKey:'b-test',model:'m',enabled:true}],
 financeFolderPath:'60 - Personal/Finances',magicFolderPath:'60 - Personal/Finances/Inbox',archiveFolderPath:'60 - Personal/Finances/Archive',defaultInputCurrency:'JPY',
 users:[{id:'default',name:'Me',folder:'60 - Personal/Finances',color:'#111111'},{id:'u2',name:'Two',folder:'60 - Personal/Finances/Two',color:'#222222'}],currentUser:'default',sidebarWidth:292,dailyJournalEnabled:true,dailyJournalFolderPath:'Journal',dailyJournalFilePattern:'YYYY-MM-DD'};
const v020={...v021,aiProvider:'gemini'};delete v020.apiEndpoints;
test('0.2.1 (endpoint list plus an unused single key): nothing lost, no key left in plain settings',()=>{
 const s=migrateSettings(v021,defaults);
 assert.equal(s.financeFolderPath,'60 - Personal/Finances');assert.equal(s.users.length,2);assert.equal(s.users[1].folder,'60 - Personal/Finances/Two');
 assert.equal(s.dailyJournalEnabled,true);assert.equal(s.defaultInputCurrency,'JPY');
 for(const f of ['aiProvider','openaiApiKey','geminiApiKey','geminiModel','openaiEndpoint'])assert.equal(f in s,false,f+' is gone');
 assert.deepEqual(JSON.parse(JSON.stringify(s.apiEndpoints.map(e=>[e.id,e.enabled,e.provider,e.vision]))),[['1',true,'custom',true],['2',true,'custom',true],['migrated-legacy',false,'custom',true],['migrated-gemini',false,'gemini',true]]);
 assert.equal(s.apiEndpoints[2].apiKey,'legacy-test');assert.equal(s.apiEndpoints[2].endpoint,'https://legacy.example/v1');
 assert.equal(s.apiEndpoints[3].apiKey,'g-test','the Gemini key moves with its entry, to secret storage afterwards');assert.equal(s.apiEndpoints[3].model,'gemini-2.5-flash-lite');
 assert.equal(s.recurring.length,0);assert.equal(s.budgetText,'');assert.deepEqual(JSON.parse(JSON.stringify(s.drafts)),[]);
 assert.equal(v021.openaiApiKey,'legacy-test','the input is not changed');
});
test('0.2.0 (Gemini chosen, single OpenAI key kept): Gemini first and on, OpenAI kept off',()=>{
 const s=migrateSettings(v020,defaults);
 assert.deepEqual(JSON.parse(JSON.stringify(s.apiEndpoints.map(e=>[e.id,e.enabled,e.provider]))),[['migrated-gemini',true,'gemini'],['migrated-default',false,'custom']]);
});
test('a single key that is already in the list is not added twice',()=>{
 const s=migrateSettings({...v021,openaiApiKey:'a-test'},defaults);
 assert.equal(s.apiEndpoints.filter(e=>e.provider!=='gemini').length,2);
});
test('0.5.0 shape: Gemini secret by name, DeepSeek and a local proxy in the list',()=>{
 const v050={aiProvider:'openai',geminiSecretName:'gemini-api-key',geminiApiKey:'',geminiModel:'model-g',apiEndpoints:[
  {id:'d',name:'Deepseek',endpoint:'https://api.deepseek.com/v1',apiKey:'',apiKeySecret:'ai-accounting-endpoint-d',model:'deepseek-v4-pro',enabled:true},
  {id:'p',name:'Proxy',endpoint:'http://localhost:2048/v1',apiKey:'',apiKeySecret:'ai-accounting-endpoint-p',model:'m',enabled:true}]};
 const s=migrateSettings(v050,defaults);
 assert.deepEqual(JSON.parse(JSON.stringify(s.apiEndpoints.map(e=>[e.id,e.provider,e.enabled,e.apiKeySecret||'']))),[['d','deepseek',true,'ai-accounting-endpoint-d'],['p','custom',true,'ai-accounting-endpoint-p'],['migrated-gemini','gemini',false,'gemini-api-key']]);
 assert.equal(s.apiEndpoints[0].model,'deepseek-v4-pro','models the user picked are kept');
});
