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
    // Optionally inject the desktop OAuth client secret at build time so the
    // repository never carries it (the constant stays empty in source).
    let code = result.outputText;
    const secret = process.env.GOOGLE_DESKTOP_CLIENT_SECRET;
    if (secret && name === 'host/account.js') {
      code = code.replace("GOOGLE_DESKTOP_CLIENT_SECRET = '';", `GOOGLE_DESKTOP_CLIENT_SECRET = ${JSON.stringify(secret)};`);
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, code);
    if (/^(app|i18n|security)\//.test(name) || name === 'storage/markdown.js') {
      const browser = join('dist/web', name);
      await mkdir(dirname(browser), { recursive: true }); await writeFile(browser, code);
    }
  }
}
await compile('src');
await copyFile('src/app/index.html', 'dist/web/index.html');
await copyFile('src/app/app.css', 'dist/web/app.css');
await mkdir('dist/web/vendor', { recursive: true });
await copyFile('node_modules/pdfjs-dist/build/pdf.min.mjs', 'dist/web/vendor/pdf.mjs');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/web/vendor/pdf.worker.mjs');
await copyFile('node_modules/fflate/esm/browser.js', 'dist/web/vendor/fflate.js');
await cp('assets', 'dist/assets', { recursive: true });
await sourceArchive();
console.log('Built desktop and Android web assets.');
