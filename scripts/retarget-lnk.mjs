// Retargets a Windows .lnk to a new executable **without** touching any length
// field: the replacement name must have exactly the same number of characters
// as the old one, and the shortcut keeps its byte size.
//
// Why not just use WScript.Shell? Because this environment blocks COM
// instantiation (and csc/Add-Type), so a structural rewrite is not available.
// An equal-length swap is also strictly safer: no length prefixes, LinkInfo
// cbSize, or StringData blocks ever need recomputing.
//
// Usage: node scripts/retarget-lnk.mjs <shortcut.lnk> <old-basename> <new-basename>
import { readFileSync, writeFileSync } from 'node:fs';

const [lnk, oldName, newName] = process.argv.slice(2);
if (!lnk || !oldName || !newName) {
  console.error('usage: node scripts/retarget-lnk.mjs <shortcut.lnk> <old-basename> <new-basename>');
  process.exit(2);
}
if (oldName.length !== newName.length) {
  console.error(`lengths differ: ${oldName.length} vs ${newName.length} - an equal-length swap is required`);
  process.exit(3);
}

const original = readFileSync(lnk);
const output = Buffer.from(original);

// A .lnk stores the target three times in practice: once as a single-byte
// (latin1) LocalBasePath inside LinkInfo, and twice as UTF-16LE (relative path
// and, in older files, the LinkInfo tail). Replace both encodings.
function replaceAll(haystack, needle, replacement) {
  let hits = 0;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (haystack.subarray(i, i + needle.length).equals(needle)) {
      replacement.copy(haystack, i);
      hits++;
      i += needle.length - 1;
    }
  }
  return hits;
}

// UTF-16 first: its byte pattern cannot be a prefix of the latin1 one, and
// doing it first keeps indices simple either way.
const utf16Hits = replaceAll(output, Buffer.from(oldName, 'utf16le'), Buffer.from(newName, 'utf16le'));
const latinHits = replaceAll(output, Buffer.from(oldName, 'latin1'), Buffer.from(newName, 'latin1'));

writeFileSync(lnk, output);

console.log(JSON.stringify({
  lnk,
  oldName,
  newName,
  utf16Hits,
  latinHits,
  sizeBefore: original.length,
  sizeAfter: output.length,
  stillHasOld: output.includes(Buffer.from(oldName, 'latin1')) || output.includes(Buffer.from(oldName, 'utf16le')),
}, null, 2));
