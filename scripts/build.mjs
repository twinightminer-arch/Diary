import ts from 'typescript';
import { mkdir, copyFile, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { sourceArchive } from './source-archive.mjs';

// Emit native ES modules: no frontend runtime dependencies or bundler required.
async function compile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) { await compile(source); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const name = relative('src', source).replaceAll('\\', '/').replace(/\.ts$/, '.js');
    const preload = name === 'desktop/preload.js';
    const output = join('dist', preload ? 'desktop/preload.cjs' : name);
    const result = ts.transpileModule(await readFile(source, 'utf8'), {
      fileName: source,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: preload ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true, verbatimModuleSyntax: !preload },
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, result.outputText);
    if (/^(app|i18n|security)\//.test(name) || name === 'storage/markdown.js') {
      const browser = join('dist/web', name);
      await mkdir(dirname(browser), { recursive: true }); await writeFile(browser, result.outputText);
    }
  }
}
await compile('src');
await copyFile('src/app/index.html', 'dist/web/index.html');
await copyFile('src/app/app.css', 'dist/web/app.css');
await cp('assets', 'dist/assets', { recursive: true });
await sourceArchive();
console.log('Built desktop and Android web assets.');
