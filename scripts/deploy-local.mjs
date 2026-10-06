// Deploy the freshly built portable exe and repoint the desktop shortcut.
//
// The shortcut stores its target three times (path in the link-target block,
// plus the string data), in latin1 and UTF-16LE. `Portal-Fix` and `UI-Rebuild`
// are both 10 characters, so the replacement is byte-for-byte equal length and
// the .lnk structure stays valid — no COM / no WScript.Shell needed.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const releases = resolve('..', 'releases');
const target = resolve(releases, 'Diary-0.1.1-UI-Rebuild-Windows-Portable.exe');
const source = resolve(releases, 'Diary-0.1.1-Windows-Portable.exe');
const link = 'C:/Users/李忠浩/OneDrive/Desktop(1)/Diary.lnk';
const OLD = 'Portal-Fix';
const NEW = 'UI-Rebuild';

if (OLD.length !== NEW.length) throw new Error('replacement must be equal length');
if (!existsSync(source)) throw new Error(`build output missing: ${source}`);
copyFileSync(source, target);
console.log('deployed', target);

const buffer = readFileSync(link);
const replaceAll = (needle, replacement) => {
  const from = Buffer.from(needle, replacement === null ? 'latin1' : 'utf8');
  const to = Buffer.from(replacement, 'utf8');
  let count = 0;
  let index = buffer.indexOf(from);
  while (index >= 0) { to.copy(buffer, index); count += 1; index = buffer.indexOf(from, index + to.length); }
  return count;
};

// UTF-16LE first: the latin1 pass would corrupt the alternating zero bytes.
const wideFrom = Buffer.from(OLD, 'utf16le');
const wideTo = Buffer.from(NEW, 'utf16le');
if (wideFrom.length !== wideTo.length) throw new Error('utf16 replacement must be equal length');
let wide = 0;
for (let index = buffer.indexOf(wideFrom); index >= 0; index = buffer.indexOf(wideFrom, index + wideTo.length)) { wideTo.copy(buffer, index); wide += 1; }

const narrowFrom = Buffer.from(OLD, 'latin1');
const narrowTo = Buffer.from(NEW, 'latin1');
let narrow = 0;
for (let index = buffer.indexOf(narrowFrom); index >= 0; index = buffer.indexOf(narrowFrom, index + narrowTo.length)) { narrowTo.copy(buffer, index); narrow += 1; }

if (wide + narrow === 0 && !readFileSync(link).toString('latin1').includes(NEW)) {
  throw new Error(`neither ${OLD} nor ${NEW} found in the shortcut — refusing to write a no-op`);
}

writeFileSync(link, buffer);
console.log(`shortcut rewired: ${wide} utf16 + ${narrow} latin1 replacement(s)`);

const check = readFileSync(link).toString('latin1');
console.log(`shortcut now targets ${NEW}:`, check.includes(NEW));
console.log(`leftover ${OLD}:`, check.includes(OLD));
