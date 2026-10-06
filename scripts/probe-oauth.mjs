// Verify the real Google OAuth client against Google's token endpoint through
// the app's own network stack (net.fetch -> system proxy).
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';

await mkdir('work/probe', { recursive: true });
const home = await mkdtemp(resolve('work/probe/run-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: ['--no-sandbox', resolve('.')],
  env,
  timeout: 30000,
});
try {
  const result = await app.evaluate(async ({ net, session }, args) => {
    const probe = async (secret) => {
      const body = new URLSearchParams({
        client_id: args.clientId,
        code: 'probe_invalid_code',
        code_verifier: 'a'.repeat(43),
        redirect_uri: 'http://127.0.0.1:41234/oauth2callback',
        grant_type: 'authorization_code',
      });
      if (secret) body.set('client_secret', secret);
      const response = await net.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      });
      return { status: response.status, body: (await response.text()).slice(0, 260) };
    };
    const out = { proxy: await session.defaultSession.resolveProxy('https://oauth2.googleapis.com') };
    try { out.withoutSecret = await probe(null); } catch (error) { out.withoutSecret = String(error); }
    try { out.withSecret = await probe(args.secret); } catch (error) { out.withSecret = String(error); }
    return out;
  }, {
    // Never inline credentials here: GitHub secret scanning rejects the push
    // (HTTP 422, "Secret detected in content") and anything pushed is public
    // forever. Pass them in for a one-off probe instead:
    //   GOOGLE_DESKTOP_CLIENT_ID=... GOOGLE_DESKTOP_CLIENT_SECRET=... node scripts/probe-oauth.mjs
    clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID || '',
    secret: process.env.GOOGLE_DESKTOP_CLIENT_SECRET || '',
  });
  console.log('VERIFY_RESULT ' + JSON.stringify(result, null, 2));
} finally {
  await app.close();
}
