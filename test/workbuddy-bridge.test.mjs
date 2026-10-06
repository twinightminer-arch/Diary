// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePluginDirectory, loadPlugins, providerNeedsKey } from '../src/host/plugins.ts';

/**
 * The WorkBuddy bridge is only useful if it authenticates on its own. The
 * desktop app keeps its Keycloak token in memory, so the shipped plugin has to
 * lift it out with the helper script and hand it to the CLI through
 * `CODEBUDDY_AUTH_TOKEN`. If any link in that chain is edited away, the user
 * lands back at a "please run /login" prompt, which is exactly the bug these
 * assertions guard.
 */
test('the shipped WorkBuddy plugin authenticates without a manual login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-plugins-'));
  await ensurePluginDirectory(directory);
  const source = await readFile(join(directory, 'workbuddy.mjs'), 'utf8');

  assert.match(source, /CODEBUDDY_AUTH_TOKEN/, 'the plugin must pass the token to the CLI');
  assert.match(source, /workbuddy-token\.py/, 'the plugin must look for the token helper');
  assert.match(source, /sessionToken/, 'the plugin must have a cached token path');
  assert.match(source, /discoverToken/, 'the plugin must be able to refresh an expired token');
  // The API-key variable is what used to be set; if it comes back as the
  // primary credential the CLI answers 401 and the user sees the login prompt.
  assert.doesNotMatch(source, /env\.CODEBUDDY_API_KEY\s*=/, 'the API-key variable must not be the credential');
  assert.match(source, /SERVER__PORT/, 'the port collision workaround must survive');
});

test('the token helper script ships next to the plugin expectations', async () => {
  const script = await readFile(new URL('../resources/workbuddy-token.py', import.meta.url), 'utf8');
  assert.match(script, /CODEBUDDY_AUTH_TOKEN|realms\/copilot/, 'helper must target the WorkBuddy realm');
  assert.match(script, /ReadProcessMemory/, 'helper reads the running app memory');
  assert.match(script, /json\.dump/, 'helper speaks JSON on stdout');
});

test('a PowerShell twin covers machines without Python', async () => {
  const script = await readFile(new URL('../resources/workbuddy-token.ps1', import.meta.url), 'utf8');
  assert.match(script, /realms\/copilot/, 'helper must target the WorkBuddy realm');
  assert.match(script, /ReadProcessMemory/, 'helper reads the running app memory');
  assert.match(script, /ConvertTo-Json/, 'helper speaks JSON on stdout');

  const source = await readFile(new URL('../src/host/plugins.ts', import.meta.url), 'utf8');
  assert.match(source, /powershellBinaries/, 'the plugin must fall back to PowerShell');
});

test('the token helper is packaged as a real file beside the asar', async () => {
  const builder = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(builder, /extraResources/, 'the helper must be unpacked or the plugin cannot spawn it');
  assert.match(builder, /workbuddy-token\.py/, 'the Python helper must be listed in extraResources');
  assert.match(builder, /workbuddy-token\.ps1/, 'the PowerShell helper must be listed too');
});

test('the plugin loads as a keyless provider that owns its transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-plugins-'));
  const loaded = await loadPlugins(directory);
  assert.deepEqual(loaded.errors, [], 'the shipped plugin must not fail to import');

  const provider = loaded.providers.find(entry => entry.id === 'workbuddy');
  assert.ok(provider, 'workbuddy provider must be exported');
  assert.equal(typeof provider.chat, 'function', 'the provider must implement chat()');
  assert.equal(providerNeedsKey(provider), false, 'a self-transporting backend needs no key');
});
