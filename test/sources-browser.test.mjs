import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { zipSync } from 'fflate';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

function pdfFixture() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 54 >>\nstream\nBT /F1 18 Tf 72 700 Td (School notice page one) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('browser extracts DOCX headings and PDF page citations locally', { timeout: 30000 }, async () => {
  const root = resolve('dist/web');
  const server = createServer(async (request, response) => {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '\\')) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', { '.mjs': 'application/javascript', '.js': 'application/javascript', '.html': 'text/html' }[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>缓考规定</w:t></w:r></w:p><w:p><w:r><w:t>申请须提交证明</w:t></w:r></w:p></w:body></w:document>';
    const docx = zipSync({ 'word/document.xml': new TextEncoder().encode(xml) });
    const result = await page.evaluate(async ({ docx, pdf }) => {
      const { extractSource } = await import('/app/sources.js');
      return {
        docx: await extractSource('规定.docx', new Uint8Array(docx)),
        pdf: await extractSource('公告.pdf', new Uint8Array(pdf)),
      };
    }, { docx: Array.from(docx), pdf: Array.from(pdfFixture()) });
    assert.equal(result.docx[0].label, '缓考规定');
    assert.match(result.docx[0].text, /提交证明/);
    assert.equal(result.pdf[0].label, '第 1 页');
    assert.match(result.pdf[0].text, /School notice/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
