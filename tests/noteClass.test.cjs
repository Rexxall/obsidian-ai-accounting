const {test}=require('node:test'),assert=require('node:assert/strict');
const {withCssClass}=require('./load.cjs').load('src/services/noteClass.ts');
test('the note class joins the classes a note already has, once',()=>{
 const fm={cssclasses:['wide']};
 withCssClass(fm,'ledger-note');withCssClass(fm,'ledger-note');
 assert.deepEqual([...fm.cssclasses],['wide','ledger-note']);
});
test('the old cssclass field becomes cssclasses',()=>{
 const fm={cssclass:'a b'};
 withCssClass(fm,'c');
 assert.equal('cssclass' in fm,false);
 assert.deepEqual([...fm.cssclasses],['a','b','c']);
});
test('an empty or invalid class leaves the note alone',()=>{
 for(const value of ['','  ','1x','a b',undefined]){const fm={};withCssClass(fm,value);assert.deepEqual(fm,{});}
});
