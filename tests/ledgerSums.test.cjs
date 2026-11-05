const {test}=require('node:test'),assert=require('node:assert/strict');
const {amountOf,summarize,barShare,formatMoney}=require('./load.cjs').load('src/services/ledgerSums.ts');
test('amounts are read from numbers and from text with separators and symbols',()=>{
 assert.equal(amountOf(1234.5),1234.5);
 assert.equal(amountOf('1,234.50'),1234.5);
 assert.equal(amountOf('¥1,234'),1234);
 assert.equal(amountOf('-35 USD'),-35);
 assert.equal(amountOf('12 / 15'),null);
 assert.equal(amountOf(''),null);
 assert.equal(amountOf(null),null);
 assert.equal(amountOf(Infinity),null);
});
test('totals, average and the largest amount for scaling',()=>{
 assert.deepEqual({...summarize([100,-20,50])},{total:130,count:3,average:130/3,max:100});
 assert.deepEqual({...summarize([])},{total:0,count:0,average:0,max:0});
});
test('bars scale to the largest amount and never vanish',()=>{
 assert.equal(barShare(50,100),0.5);
 assert.equal(barShare(-100,100),1);
 assert.equal(barShare(0.1,100),0.02);
 assert.equal(barShare(0,100),0);
 assert.equal(barShare(5,0),0);
});
test('money is formatted in the report currency, or falls back for an unknown code',()=>{
 assert.equal(formatMoney(1234.5,'JPY','en-US'),'¥1,234.5');
 assert.match(formatMoney(12,'XYZ1','en-US'),/12 XYZ1/);
 assert.equal(formatMoney(146200,'CNY','en-US',true),'CN¥146,200');
});
