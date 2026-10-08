import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Android shell allows screenshots and serves canonical asset paths', async () => {
  const activity = await readFile('android/src/app/diary/local/MainActivity.java', 'utf8');
  const build = await readFile('scripts/build-android.ps1', 'utf8');
  const manifest = await readFile('android/AndroidManifest.xml', 'utf8');

  assert.doesNotMatch(activity, /FLAG_SECURE|WindowManager/);
  assert.match(activity, /appassets\.androidplatform\.net/);
  assert.doesNotMatch(build, /'-A',\(Join-Path \$root 'dist\/web'\)/);
  assert.match(build, /'assets'/);
  assert.match(manifest, /android:versionCode="7"/);
  assert.match(manifest, /android:versionName="0\.1\.3"/);
});
