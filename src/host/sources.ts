// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SchoolSource } from '../app/sources.ts';

const directory = (vault: string) => join(vault, 'school-sources');
const sourcePath = (vault: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid source id');
  return join(directory(vault), `${id}.json`);
};

export async function saveSource(vault: string, input: SchoolSource & { data: string }): Promise<SchoolSource> {
  if (!/^[a-f0-9-]{36}$/.test(input.id) || !/\.(pdf|docx|txt)$/i.test(input.name) || input.name.length > 255 ||
      input.department.length > 120 || !Array.isArray(input.sections) || !input.sections.length ||
      input.sections.some(section => typeof section.label !== 'string' || typeof section.text !== 'string' || !section.text.trim()) ||
      typeof input.data !== 'string' || input.data.length > 28_000_000) throw new Error('Invalid school source');
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('文件超过 20 MB');
  const folder = directory(vault);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = sourcePath(vault, input.id), temporary = join(folder, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(input), { mode: 0o600 });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => undefined); }
  const { data: _data, ...summary } = input;
  return summary;
}

export async function listSources(vault: string): Promise<SchoolSource[]> {
  let names: string[];
  try { names = await readdir(directory(vault)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const sources = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => {
    const { data: _data, ...source } = JSON.parse(await readFile(join(directory(vault), name), 'utf8')) as SchoolSource & { data: string };
    return source;
  }));
  return sources.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function deleteSource(vault: string, id: string): Promise<void> {
  await unlink(sourcePath(vault, id));
}
