const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
const module_={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync(__dirname+'/../src/services/migrate.ts','utf8'),{loader:'ts',format:'cjs'}).code,{module:module_,exports:module_.exports});
const {migrateSettings}=module_.exports;
const defaults={baseCurrency:'CNY',aiProvider:'gemini',geminiSecretName:'',geminiApiKey:'',geminiModel:'gemini-2.5-flash',openaiApiKey:'',openaiModel:'gpt-4o',openaiEndpoint:'https://api.openai.com/v1',apiEndpoints:[],financeFolderPath:'Finances',magicFolderPath:'Finances/Inbox',archiveFolderPath:'Finances/Archive',defaultInputCurrency:'CNY',users:[{id:'default',name:'Me',folder:'Finances',color:'#000000'}],currentUser:'default',sidebarWidth:250,dailyJournalEnabled:false,dailyJournalFolderPath:'',dailyJournalFilePattern:'YYYY-MM-DD',budgetText:'',recurring:[]};
// Same shape as real 0.2.x files, every value made up.
const v021={baseCurrency:'CNY',aiProvider:'openai',geminiApiKey:'g-test',geminiModel:'gemini-2.5-flash-lite',openaiApiKey:'legacy-test',openaiModel:'model-x',openaiEndpoint:'https://legacy.example/v1',
 apiEndpoints:[{id:'1',name:'A',endpoint:'https://a.example/v1',apiKey:'a-test',model:'m',enabled:true},{id:'2',name:'B',endpoint:'https://b.example/v1',apiKey:'b-test',model:'m',enabled:true}],
 financeFolderPath:'60 - Personal/Finances',magicFolderPath:'60 - Personal/Finances/Inbox',archiveFolderPath:'60 - Personal/Finances/Archive',defaultInputCurrency:'JPY',
 users:[{id:'default',name:'Me',folder:'60 - Personal/Finances',color:'#111111'},{id:'u2',name:'Two',folder:'60 - Personal/Finances/Two',color:'#222222'}],currentUser:'default',sidebarWidth:292,dailyJournalEnabled:true,dailyJournalFolderPath:'Journal',dailyJournalFilePattern:'YYYY-MM-DD'};
const v020={...v021,aiProvider:'gemini'};delete v020.apiEndpoints;
test('0.2.1 (endpoint list plus an unused single key): nothing lost, no key left in plain settings',()=>{
 const s=migrateSettings(v021,defaults);
 assert.equal(s.financeFolderPath,'60 - Personal/Finances');assert.equal(s.users.length,2);assert.equal(s.users[1].folder,'60 - Personal/Finances/Two');
 assert.equal(s.dailyJournalEnabled,true);assert.equal(s.defaultInputCurrency,'JPY');assert.equal(s.aiProvider,'openai');
 assert.equal(s.openaiApiKey,'');
 assert.deepEqual(JSON.parse(JSON.stringify(s.apiEndpoints.map(e=>[e.id,e.enabled]))),[['1',true],['2',true],['migrated-legacy',false]]);
 assert.equal(s.apiEndpoints[2].apiKey,'legacy-test');assert.equal(s.apiEndpoints[2].endpoint,'https://legacy.example/v1');
 assert.equal(s.recurring.length,0);assert.equal(s.budgetText,'');
 assert.equal(v021.openaiApiKey,'legacy-test','the input is not changed');
});
test('0.2.0 (single key only, the phone copy): it becomes the first endpoint',()=>{
 const s=migrateSettings(v020,defaults);
 assert.equal(s.aiProvider,'gemini');assert.equal(s.openaiApiKey,'');
 assert.equal(s.apiEndpoints.length,1);assert.equal(s.apiEndpoints[0].id,'migrated-default');assert.equal(s.apiEndpoints[0].enabled,true);
});
test('a single key that is already in the list is not added twice',()=>{
 const s=migrateSettings({...v021,openaiApiKey:'a-test'},defaults);
 assert.equal(s.apiEndpoints.length,2);assert.equal(s.openaiApiKey,'');
});
