// Bundles a source file with its imports and runs it with a stand-in for the Obsidian module.
const esbuild=require('esbuild'),vm=require('node:vm'),path=require('node:path');
function load(entry,obsidian={},globals={}){
 const code=esbuild.buildSync({entryPoints:[path.join(__dirname,'..',entry)],bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'}).outputFiles[0].text;
 const module={exports:{}};
 const shim={getLanguage:()=>'zh',Notice:class{},requestUrl:async()=>{throw new Error('No network in tests.');},...obsidian};
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='obsidian'?shim:require(name),console:{log(){},warn(){},error(){}},window:{setTimeout,clearTimeout},crypto:require('node:crypto').webcrypto,TextEncoder,URL,Date,Map,Set,JSON,Object,Promise,...globals});
 return module.exports;
}
module.exports={load};
