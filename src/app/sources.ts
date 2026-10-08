// SPDX-License-Identifier: AGPL-3.0-only
export type SourceSection = { label: string; text: string };
export type SchoolSource = {
  id: string; name: string; department: string; importedAt: string;
  sections: SourceSection[];
};
export type SourceHit = { source: SchoolSource; section: SourceSection; score: number };

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2_000_000;

export function splitSection(label: string, text: string): SourceSection[] {
  const clean = text.replace(/\u0000/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const pieces: SourceSection[] = [];
  for (let start = 0; start < clean.length; start += 1400) {
    const end = Math.min(clean.length, start + 1600);
    pieces.push({ label: clean.length > 1600 ? `${label} · 第 ${pieces.length + 1} 段` : label, text: clean.slice(start, end) });
    if (end === clean.length) break;
  }
  return pieces;
}

export async function extractSource(name: string, bytes: Uint8Array): Promise<SourceSection[]> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('文件须在 1 B 至 20 MB 之间');
  const extension = name.toLowerCase().split('.').pop();
  let sections: SourceSection[] = [];
  if (extension === 'txt') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sections = splitSection('正文', text);
  } else if (extension === 'docx') {
    const path = '../vendor/fflate.js';
    const { unzipSync } = await import(path) as { unzipSync: (input: Uint8Array, options: { filter: (entry: { name: string; originalSize: number }) => boolean }) => Record<string, Uint8Array> };
    const xmlBytes = unzipSync(bytes, { filter: entry => entry.name === 'word/document.xml' && entry.originalSize <= 8_000_000 })['word/document.xml'];
    if (!xmlBytes) throw new Error('DOCX 缺少正文');
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('DOCX 正文格式损坏');
    const paragraphs = Array.from(xml.getElementsByTagName('w:p'));
    let heading = '正文', body: string[] = [];
    const flush = () => { sections.push(...splitSection(heading, body.join('\n'))); body = []; };
    for (const paragraph of paragraphs) {
      const text = Array.from(paragraph.getElementsByTagName('w:t')).map(node => node.textContent ?? '').join('').trim();
      if (!text) continue;
      const style = paragraph.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
      if (/^(Heading|Title|标题|heading)/i.test(style)) { flush(); heading = text.slice(0, 100); }
      else body.push(text);
    }
    flush();
  } else if (extension === 'pdf') {
    const path = '../vendor/pdf.mjs';
    const pdfjs = await import(path) as { GlobalWorkerOptions: { workerSrc: string }; getDocument: (options: object) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }> }> } };
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
    const pdf = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
    if (pdf.numPages > 1000) throw new Error('PDF 超过 1000 页，请拆分文件');
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items.map(item => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join('');
      sections.push(...splitSection(`第 ${page} 页`, text));
      if (sections.reduce((size, section) => size + section.text.length, 0) > MAX_TEXT) throw new Error('提取文字超过 200 万字，请拆分文件');
    }
  } else throw new Error('仅支持 PDF、DOCX 和 TXT 文件');
  const total = sections.reduce((size, section) => size + section.text.length, 0);
  if (!total) throw new Error('未提取到可检索文字；扫描版 PDF 需要先进行 OCR');
  if (total > MAX_TEXT) throw new Error('提取文字超过 200 万字，请拆分文件');
  return sections;
}

function terms(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const result = new Set(normalized.match(/[a-z0-9]{2,}/g) ?? []);
  for (const sequence of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < sequence.length; i++) result.add(sequence.slice(i, i + 2));
  }
  return result;
}

export function searchSources(query: string, sources: SchoolSource[], limit = 6): SourceHit[] {
  const wanted = terms(query);
  if (!wanted.size) return [];
  const hits: SourceHit[] = [];
  for (const source of sources) for (const section of source.sections) {
    const body = terms(section.text);
    const heading = terms(`${source.name} ${source.department} ${section.label}`);
    let score = 0;
    for (const term of wanted) score += (heading.has(term) ? 3 : 0) + (body.has(term) ? 1 : 0);
    if (score) hits.push({ source, section, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const selected: SourceHit[] = [], perSource = new Map<string, number>();
  for (const hit of hits) {
    if ((perSource.get(hit.source.id) ?? 0) >= 3) continue;
    selected.push(hit); perSource.set(hit.source.id, (perSource.get(hit.source.id) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}
