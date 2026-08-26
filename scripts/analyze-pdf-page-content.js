const fs = require('fs');
const { PDFDocument, PDFArray } = require('pdf-lib');

async function streamBytes(pdf, page) {
  const contents = page.node.Contents();
  if (!contents) return 0;
  const refs = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents];
  return refs.reduce((total, ref) => {
    const stream = pdf.context.lookup(ref);
    return total + (stream && stream.contents ? stream.contents.length : 0);
  }, 0);
}

(async () => {
  for (const file of process.argv.slice(2)) {
    const pdf = await PDFDocument.load(fs.readFileSync(file));
    const sizes = [];
    for (const page of pdf.getPages()) sizes.push(await streamBytes(pdf, page));
    console.log(JSON.stringify({ file, sizes }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
