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

export type OAuthProvider = 'google';
export interface OAuthEndpoints { authorize: string; token: string; scope: string }
const ENDPOINTS: Record<OAuthProvider, OAuthEndpoints> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
};

/**
 * Google OAuth 2.0 client IDs.
 * - The desktop client is a "Desktop app" type and uses the OAuth 2.0 PKCE
 *   flow (loopback redirect). Per Google's guidance, native/desktop public
 *   clients do NOT need (and should not ship) a client secret. The secret is
 *   therefore left empty here and may be injected at build time via the
 *   GOOGLE_DESKTOP_CLIENT_SECRET environment variable if your Google Cloud
 *   project still requires one.
 * - The Android client is an "Android" type identified by package name +
 *   signing SHA-1 and has no secret.
 */
export const GOOGLE_DESKTOP_CLIENT_ID = '933958043196-c8ktud98bdmkbiovnns1dst47b7mcb19.apps.googleusercontent.com';
export const GOOGLE_DESKTOP_CLIENT_SECRET = '';
export const GOOGLE_ANDROID_CLIENT_ID = '933958043196-8otpn6ub49h2oo2agrdjocljl5p3559g.apps.googleusercontent.com';
export const GOOGLE_ANDROID_REDIRECT = `com.googleusercontent.apps.${GOOGLE_ANDROID_CLIENT_ID}:/oauth2callback`;
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleClientId(platform: 'desktop' | 'android'): string {
  return platform === 'desktop' ? GOOGLE_DESKTOP_CLIENT_ID : GOOGLE_ANDROID_CLIENT_ID;
}
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
  clientId: string; code: string; codeVerifier: string; redirectUri: string; clientSecret?: string;
}, fetchImpl: typeof fetch = fetch): Promise<{ access_token: string; expires_in?: number }> {
  const body = new URLSearchParams({
    client_id: params.clientId, code: params.code, code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri, grant_type: 'authorization_code',
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  });
  const response = await fetchImpl(tokenEndpoint(provider), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status})`);
  const json = await response.json() as { access_token: string; expires_in?: number };
  if (!json.access_token) throw new Error('OAuth token exchange returned no access token');
  return json;
}

/** Fetch the Google identity (email, name, picture) for a freshly minted access token. */
export async function googleUserInfo(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ email: string; name: string; picture: string }> {
  const response = await fetchImpl(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
  const json = await response.json() as { email?: string; name?: string; picture?: string };
  return { email: json.email ?? '', name: json.name ?? '', picture: json.picture ?? '' };
}
