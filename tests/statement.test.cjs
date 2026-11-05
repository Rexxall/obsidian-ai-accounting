const {test}=require('node:test'),assert=require('node:assert/strict');
const {readStatement,decodeStatement,parseCsv,normalizeDate,parseAmount}=require('./load.cjs').load('src/services/statement.ts',{},{TextDecoder});
const {learn,fromHistory,merchantKey,readCategoryReply}=require('./load.cjs').load('src/services/categorize.ts');
const plain=x=>JSON.parse(JSON.stringify(x));

const alipay=`------------------------------------------------------------------------------------
导出信息：
姓名：示例
------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,
2026-10-03 12:30:11,餐饮美食,全家便利店,fam***@m.com,饭团和咖啡,支出,18.50,花呗,交易成功,2026100322001,T1,,
2026-10-04 09:00:00,日用百货,某某超市,,洗衣液,支出,"1,029.00",招商银行储蓄卡(1234),交易关闭,2026100422002,T2,,
2026-10-05 10:00:00,退款,某某商城,,耳机退款,收入,199.00,余额,退款成功,2026100522003,T3,,
2026-10-06 18:00:00,转账红包,张三,,红包,收入,50.00,余额,交易成功,2026100622004,T4,,
2026-10-07 08:00:00,投资理财,余额宝,,余额宝-转入,不计收支,500.00,余额,交易成功,2026100722005,T5,,
`;
const wechat=`微信支付账单明细,,,,,,,,,,
微信昵称：[示例],,,,,,,,,,
----------------------微信支付账单明细列表--------------------,,,,,,,,,,
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-10-08 07:45:00,商户消费,瑞幸咖啡,生椰拿铁,支出,¥13.90,零钱,支付成功,4200001,1,/
2026-10-08 20:10:00,微信红包,李四,/,收入,¥8.88,/,已存入零钱,1000001,/,/
2026-10-09 11:00:00,零钱提现,招商银行(1234),/,/,¥200.00,招商银行(1234),提现已到账,1000002,/,/
`;
const smbc=`年月日,お引出し,お預入れ,お取り扱い内容,残高
2026/10/01,,250000,給料,512000
2026/10/02,3300,,カ－ド\u3000セブンイレブン,508700
2026/10/27,"12,000",,ﾃﾞﾝｷ\u3000トウキヨウデンリヨク,496700
`;
const rakuten=`"利用日","利用店名・商品名","利用者","支払方法","利用金額","支払手数料","支払総額"
"2026/10/12","ローソン\u3000新宿三丁目店","本人","1回払い","598","0","598"
"2026/10/15","ＪＲ東日本モバイルＳｕｉｃａ","本人","1回払い","3,000","0","3,000"
`;
const generic=`Date,Description,Amount
10/03/2026,COFFEE,-4.50
2026-10-04,PAYROLL,2000
2026-10-05,GROCERY STORE,-82.10
2026-10-06,REFUND GROCERY,12.00
`;

test('Alipay: preamble skipped, closed rows dropped, income left out, refund negative, 不计收支 a transfer',()=>{
 const s=readStatement(alipay,'JPY');
 assert.equal(s.source,'alipay');
 assert.deepEqual(plain(s.rows),[
  {date:'2026-10-03',description:'全家便利店 · 饭团和咖啡',amount:18.5,currency:'CNY',paymentMethod:'花呗',hint:'餐饮美食'},
  {date:'2026-10-05',description:'某某商城 · 耳机退款',amount:-199,currency:'CNY',paymentMethod:'余额',hint:'退款'},
  {date:'2026-10-07',description:'余额宝 · 余额宝-转入',amount:500,currency:'CNY',paymentMethod:'余额',hint:'转账'}]);
 assert.equal(s.income,1); assert.equal(s.skipped,1);
});
test('Alipay files in GB18030 are decoded',()=>{
 const gbk=new Uint8Array([0xd6,0xa7,0xb3,0xf6]); // 支出
 assert.equal(decodeStatement(gbk),'支出');
 assert.equal(decodeStatement(new TextEncoder().encode('﻿交易时间')),'交易时间');
});
test('WeChat Pay: ¥ amounts, red packets received left out, withdrawals are transfers',()=>{
 const s=readStatement(wechat,'JPY');
 assert.equal(s.source,'wechat');
 assert.deepEqual(plain(s.rows.map(r=>[r.description,r.amount,r.currency,r.paymentMethod,r.hint])),[['瑞幸咖啡 · 生椰拿铁',13.9,'CNY','零钱',''],['招商银行(1234)',200,'CNY','招商银行(1234)','转账']]);
 assert.equal(s.income,1);
});
test('a Japanese bank: withdrawals are spending in yen, deposits are income',()=>{
 const s=readStatement(smbc,'CNY');
 assert.equal(s.source,'bank');
 assert.deepEqual(plain(s.rows.map(r=>[r.date,r.description,r.amount,r.currency])),[['2026-10-02','カ－ド\u3000セブンイレブン',3300,'JPY'],['2026-10-27','ﾃﾞﾝｷ\u3000トウキヨウデンリヨク',12000,'JPY']]);
 assert.equal(s.income,1);
});
test('a Japanese card statement with quoted cells',()=>{
 const s=readStatement(rakuten,'CNY','楽天カード');
 assert.equal(s.source,'card');
 assert.deepEqual(plain(s.rows.map(r=>[r.description,r.amount,r.currency,r.paymentMethod])),[['ローソン\u3000新宿三丁目店',598,'JPY','楽天カード'],['ＪＲ東日本モバイルＳｕｉｃａ',3000,'JPY','楽天カード']]);
});
test('a signed amount column: negatives are spending, a positive refund is a refund, other positives are income',()=>{
 const s=readStatement(generic,'USD','Visa');
 assert.deepEqual(plain(s.rows.map(r=>[r.date,r.description,r.amount,r.currency])),[['2026-10-05','GROCERY STORE',82.1,'USD'],['2026-10-06','REFUND GROCERY',-12,'USD']]);
 assert.equal(s.income,1);
 assert.deepEqual(plain(readStatement('Date,Description,Amount\n2026-10-05,SHOP,30\n','USD').rows.map(r=>r.amount)),[30]);
 assert.equal(s.skipped,1); // 10/03/2026 is not a date this reader trusts
});
test('a file that is not a statement gives no rows',()=>{
 assert.equal(readStatement('a,b\n1,2\n','CNY').rows.length,0);
 assert.equal(readStatement('','CNY').rows.length,0);
});
test('CSV quoting, line breaks in cells and tabs',()=>{
 assert.deepEqual(plain(parseCsv('a,"b,c","d ""e"""\r\n1,"x\ny",3')),[['a','b,c','d "e"'],['1','x\ny','3']]);
 assert.deepEqual(plain(parseCsv('a\tb\n1\t2')),[['a','b'],['1','2']]);
});
test('dates and amounts in the forms statements use',()=>{
 assert.equal(normalizeDate('2026/11/3 12:00'),'2026-11-03');
 assert.equal(normalizeDate('2026年11月3日'),'2026-11-03');
 assert.equal(normalizeDate('20261103'),'2026-11-03');
 assert.equal(normalizeDate('26/11/03'),'2026-11-03');
 assert.equal(normalizeDate('2026-02-30'),'');
 assert.equal(parseAmount('¥1,234.50'),1234.5);
 assert.equal(parseAmount('(35.00)'),-35);
 assert.equal(parseAmount('１２００円'),1200);
 assert.equal(parseAmount('▲500'),-500);
 assert.equal(parseAmount('/'),null);
});

test('your own ledger files a known shop again, exactly or inside a longer description',()=>{
 const m=learn([{description:'FamilyMart 新宿店',category:'餐饮美食 / 便利店'},{description:'familymart新宿店',category:'餐饮美食 / 便利店'},{description:'FamilyMart 新宿店',category:'购物消费 / 日用'},{description:'瑞幸咖啡',category:'餐饮美食 / 咖啡'},{description:'x',category:'其他支出 / 一般'}]);
 assert.equal(fromHistory('FAMILYMART 新宿店 #12',m),'餐饮美食 / 便利店');
 assert.equal(fromHistory('瑞幸咖啡 · 生椰拿铁',m),'餐饮美食 / 咖啡');
 assert.equal(fromHistory('Lawson',m),null);
 assert.deepEqual(plain(m.categories),['其他支出 / 一般','购物消费 / 日用','餐饮美食 / 便利店','餐饮美食 / 咖啡']);
 assert.equal(merchantKey('ＦａｍｉｌｙＭａｒｔ\u3000１２'),'familymart');
});
test('the AI reply is held to the rows asked about and to short plain categories',()=>{
 const got=readCategoryReply([{i:0,category:'餐饮美食/咖啡'},{i:'2',category:'交通出行 / 地铁'},{i:5,category:'不该有'},{i:1,category:{x:1}},{i:3,category:'x'.repeat(41)},null],new Set([0,1,2,3]));
 assert.deepEqual([...got],[[0,'餐饮美食 / 咖啡'],[2,'交通出行 / 地铁']]);
});
