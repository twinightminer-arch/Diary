// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILTIN_SCHOOLS, dedupeSchools, normaliseImportedSchool, searchSchools, type SchoolRecord } from '../app/schools.ts';

type StoreData = { version: 1; custom: SchoolRecord[] };

export class SchoolDirectory {
  readonly path: string;
  constructor(vault: string) { this.path = join(vault, 'school-directory.json'); }
  private async read(): Promise<StoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoreData;
      const custom = Array.isArray(parsed.custom) ? parsed.custom.map(row => normaliseImportedSchool(row, row.updatedAt)).filter((row): row is SchoolRecord => !!row) : [];
      return { version: 1, custom: dedupeSchools(BUILTIN_SCHOOLS, custom).added };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, custom: [] };
      throw error;
    }
  }
  private async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temporary, this.path); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async list(query = ''): Promise<SchoolRecord[]> { return searchSchools([...BUILTIN_SCHOOLS, ...(await this.read()).custom], query); }
  async migrate(rows: unknown[]): Promise<{ added: number; duplicates: number; schools: SchoolRecord[] }> {
    const data = await this.read();
    const valid = rows.map(row => normaliseImportedSchool((row ?? {}) as Partial<SchoolRecord> & { url?: string })).filter((row): row is SchoolRecord => !!row);
    const merged = dedupeSchools([...BUILTIN_SCHOOLS, ...data.custom], valid);
    if (merged.added.length) await this.write({ version: 1, custom: [...data.custom, ...merged.added] });
    return { added: merged.added.length, duplicates: merged.duplicates, schools: await this.list() };
  }
  async upsert(value: Partial<SchoolRecord> & { url?: string }): Promise<SchoolRecord> {
    const school = normaliseImportedSchool(value);
    if (!school) throw new Error('学校名称或 VPN 地址无效');
    const data = await this.read();
    const index = data.custom.findIndex(item => item.id === school.id);
    if (index >= 0) data.custom[index] = school;
    else {
      const merged = dedupeSchools([...BUILTIN_SCHOOLS, ...data.custom], [school]);
      if (!merged.added.length) throw new Error('该学校和 VPN 地址已经存在');
      data.custom.push(school);
    }
    await this.write(data); return school;
  }
  async remove(id: string): Promise<void> {
    if (!id.startsWith('custom-')) throw new Error('内置学校不能删除');
    const data = await this.read(), next = data.custom.filter(item => item.id !== id);
    if (next.length === data.custom.length) throw new Error('没有找到该自定义学校');
    await this.write({ version: 1, custom: next });
  }
  async get(id: string): Promise<SchoolRecord | null> { return (await this.list()).find(item => item.id === id) ?? null; }
}
