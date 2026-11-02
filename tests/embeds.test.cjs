const {test}=require('node:test'),assert=require('node:assert/strict');
const {embeddedImageLinks}=require('./load.cjs').load('src/services/embeds.ts');
test('embedded images are found in both link styles, in order, once each',()=>{
 const text=['Lunch','![[receipt.png]]','![[scan 2.JPG|300]]','![alt](attachments/receipt%203.webp)','![](<folder/r 4.jpeg> "title")','![[receipt.png]]'].join('\n');
 assert.deepEqual([...embeddedImageLinks(text)],['receipt.png','scan 2.JPG','attachments/receipt 3.webp','folder/r 4.jpeg']);
});
test('notes, PDFs, web images and plain links are not images to send',()=>{
 const text=['![[Other note]]','![[file.pdf]]','![](https://example.test/a.png)','[[receipt.png]]','[link](b.png)','![[c.png#^block]]'].join('\n');
 assert.deepEqual([...embeddedImageLinks(text)],['c.png']);
});
