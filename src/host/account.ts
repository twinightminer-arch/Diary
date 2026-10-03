// SPDX-License-Identifier: AGPL-3.0-only
import { timingSafeEqual } from 'node:crypto';
import { HostConfig } from './config.ts';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const ITERATIONS = 310_000;

function base64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString('base64');
}
async function derive(passcode: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await subtle.importKey('raw', encoder.encode(passcode) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS }, material, 256);
  return new Uint8Array(bits);
}

/** Local account is an access gate (like a Windows lock screen), not cloud auth. */
export async function setLocalPasscode(config: HostConfig, passcode: string): Promise<void> {
  if (typeof passcode !== 'string' || passcode.length < 4) throw new TypeError('Passcode needs at least 4 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passcode, salt);
  config.setLocalAccount({ salt: base64(salt), hash: base64(hash) });
  await config.save();
}
export function hasLocalAccount(config: HostConfig): boolean { return config.localAccount !== null; }
export function clearLocalAccount(config: HostConfig): void { config.setLocalAccount(null); }
export async function verifyLocalPasscode(config: HostConfig, passcode: string): Promise<boolean> {
  const account = config.localAccount;
  if (!account) return false;
  const salt = Buffer.from(account.salt, 'base64');
  const candidate = await derive(passcode, salt);
  const expected = Buffer.from(account.hash, 'base64');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export type OAuthProvider = 'google' | 'microsoft';
export interface OAuthEndpoints { authorize: string; token: string; scope: string }
const ENDPOINTS: Record<OAuthProvider, OAuthEndpoints> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid email profile offline_access',
  },
};
/** Build a PKCE authorization URL. The code verifier must be kept client-side until exchange. */
export function buildAuthUrl(provider: OAuthProvider, params: {
  clientId: string; redirectUri: string; state: string; codeChallenge: string;
}): string {
  const endpoints = ENDPOINTS[provider];
  const url = new URL(endpoints.authorize);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', endpoints.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
export function tokenEndpoint(provider: OAuthProvider): string { return ENDPOINTS[provider].token; }
export async function exchangeCode(provider: OAuthProvider, params: {
  clientId: string; code: string; codeVerifier: string; redirectUri: string;
}, fetchImpl: typeof fetch = fetch): Promise<{ access_token: string; expires_in?: number }> {
  const body = new URLSearchParams({
    client_id: params.clientId, code: params.code, code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri, grant_type: 'authorization_code',
  });
  const response = await fetchImpl(tokenEndpoint(provider), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status})`);
  const json = await response.json() as { access_token: string; expires_in?: number };
  if (!json.access_token) throw new Error('OAuth token exchange returned no access token');
  return json;
}
