// SPDX-License-Identifier: AGPL-3.0-only
import { timingSafeEqual } from 'node:crypto';
import { randomBytes, randomUUID } from 'node:crypto';
import { HostConfig, type UserAccount } from './config.ts';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const ITERATIONS = 310_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_一-龥]{2,20}$/;

function base64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString('base64');
}
async function derive(passcode: string, salt: Uint8Array): Promise<Uint8Array> {
  const material = await subtle.importKey('raw', encoder.encode(passcode) as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS }, material, 256);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Multi-user account management. Each account is fully independent: its own
// username, password, profile, Google binding and recovery question.
// ---------------------------------------------------------------------------

export function validateUsername(config: HostConfig, username: string, exceptId?: string): string {
  if (typeof username !== 'string') throw new TypeError('Username required');
  const name = username.trim();
  if (!USERNAME_PATTERN.test(name)) throw new Error('用户名需为 2-20 位中英文、数字或下划线');
  const clash = config.findUserByName(name);
  if (clash && clash.id !== exceptId) throw new Error('该用户名已被占用');
  return name;
}

export function validatePassword(passcode: string, confirmation?: string): string {
  if (typeof passcode !== 'string' || passcode.length < 6) throw new Error('密码至少 6 位');
  if (confirmation !== undefined && passcode !== confirmation) throw new Error('两次输入的密码不一致');
  return passcode;
}

/** Create a brand-new offline account with a user-chosen username. */
export async function createLocalAccount(config: HostConfig, params: {
  username: string; passcode: string; confirmation?: string; displayName?: string; autoLogin?: boolean;
}): Promise<UserAccount> {
  const username = validateUsername(config, params.username);
  const passcode = validatePassword(params.passcode, params.confirmation);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passcode, salt);
  const user: UserAccount = {
    id: randomUUID(), username,
    displayName: params.displayName?.trim() || username,
    avatar: null,
    salt: base64(salt), hash: base64(hash),
    googleId: null, googleEmail: null,
    recoveryQuestion: null, recoverySalt: null, recoveryHash: null,
    createdAt: Date.now(), lastLoginAt: Date.now(),
    autoLogin: params.autoLogin ?? false,
  };
  config.addUser(user);
  return user;
}

export async function verifyUserPassword(config: HostConfig, userId: string, passcode: string): Promise<boolean> {
  const user = config.getUser(userId);
  if (!user) return false;
  const candidate = await derive(passcode, Buffer.from(user.salt, 'base64'));
  const expected = Buffer.from(user.hash, 'base64');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

function touch(config: HostConfig, userId: string): void {
  config.updateUser(userId, { lastLoginAt: Date.now() });
}

/** Resolve a login: match username (case-insensitive) then verify the password. */
export async function signIn(config: HostConfig, username: string, passcode: string, remember: boolean): Promise<UserAccount> {
  const user = config.findUserByName(username);
  if (!user) throw new Error('用户不存在');
  if (!(await verifyUserPassword(config, user.id, passcode))) throw new Error('密码错误');
  touch(config, user.id);
  config.setSession({ userId: user.id, remember });
  if (remember) config.updateUser(user.id, { autoLogin: true });
  return user;
}

export async function changeUserPassword(config: HostConfig, userId: string, oldPasscode: string, next: string, confirmation?: string): Promise<void> {
  if (!(await verifyUserPassword(config, userId, oldPasscode))) throw new Error('原密码错误');
  validatePassword(next, confirmation);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(next, salt);
  config.updateUser(userId, { salt: base64(salt), hash: base64(hash) });
}

/** Attach (or replace) the security question used to recover a forgotten password. */
export async function setRecoveryQuestion(config: HostConfig, userId: string, question: string, answer: string): Promise<void> {
  if (typeof question !== 'string' || question.trim().length < 4) throw new Error('密保问题至少 4 个字');
  if (typeof answer !== 'string' || answer.trim().length < 2) throw new Error('密保答案至少 2 个字');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(answer.trim().toLowerCase(), salt);
  config.updateUser(userId, { recoveryQuestion: question.trim(), recoverySalt: base64(salt), recoveryHash: base64(hash) });
}

export async function verifyRecoveryAnswer(config: HostConfig, userId: string, answer: string): Promise<boolean> {
  const user = config.getUser(userId);
  if (!user || !user.recoveryHash || !user.recoverySalt) return false;
  const candidate = await derive(answer.trim().toLowerCase(), Buffer.from(user.recoverySalt, 'base64'));
  const expected = Buffer.from(user.recoveryHash, 'base64');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Reset a forgotten password after the security question is answered. */
export async function recoverPassword(config: HostConfig, userId: string, answer: string, next: string, confirmation?: string): Promise<void> {
  if (!(await verifyRecoveryAnswer(config, userId, answer))) throw new Error('密保答案不正确');
  validatePassword(next, confirmation);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(next, salt);
  config.updateUser(userId, { salt: base64(salt), hash: base64(hash) });
}

/**
 * Bind a Google identity to a local account (one Google account <-> one local
 * account). When the Google account is new, a matching offline account is
 * created automatically, carrying over the Google display name and avatar.
 */
export async function linkGoogleToUser(config: HostConfig, identity: { googleId: string; email: string; name: string; picture: string | null }, passcode?: string, confirmation?: string): Promise<UserAccount> {
  const existing = config.findUserByGoogleId(identity.googleId);
  if (existing) {
    // Refresh the cached avatar/name but keep the local username authoritative.
    config.updateUser(existing.id, {
      googleEmail: identity.email,
      displayName: existing.displayName || identity.name || existing.username,
      avatar: identity.picture ?? existing.avatar,
    });
    return config.getUser(existing.id)!;
  }
  // Bind to an existing offline account instead of spawning a duplicate one:
  // prefer the signed-in user, then the only account that has no Google link.
  const sessionUser = config.session.userId ? config.getUser(config.session.userId) : null;
  const unbound = config.users.filter(user => !user.googleId);
  const target = (sessionUser && !sessionUser.googleId ? sessionUser : null) ?? (unbound.length === 1 ? unbound[0]! : null);
  if (target) {
    config.updateUser(target.id, {
      googleId: identity.googleId,
      googleEmail: identity.email,
      // The Google display name wins so the profile matches the Google account.
      displayName: identity.name || target.displayName || target.username,
      avatar: identity.picture ?? target.avatar,
    });
    return config.getUser(target.id)!;
  }
  // Otherwise create an offline account named after the Google identity.
  const baseName = identity.name || identity.email.split('@')[0] || 'user';
  let username = baseName.replace(/[^A-Za-z0-9_一-龥]/g, '').slice(0, 20) || 'user';
  // Usernames need at least 2 characters; pad short/empty ones.
  if (username.length < 2) username += '用户'.slice(0, 2 - username.length);
  while (config.findUserByName(username)) username = `${username}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 20);
  const chosen = passcode ?? randomBytes(9).toString('base64url');
  const user = await createLocalAccount(config, {
    username, passcode: chosen, confirmation: confirmation ?? chosen,
    displayName: identity.name || username,
  });
  config.updateUser(user.id, { googleId: identity.googleId, googleEmail: identity.email, avatar: identity.picture });
  return config.getUser(user.id)!;
}

export function signOut(config: HostConfig): void { config.setSession({ userId: null, remember: false }); }

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
export const GOOGLE_DESKTOP_CLIENT_ID = 'REMOVED_GOOGLE_DESKTOP_CLIENT_ID';
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
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    // Surface Google's own error (e.g. redirect_uri_mismatch, invalid_client)
    // so the user sees the real reason instead of a bare status code.
    let detail = '';
    try { detail = (await response.text()).slice(0, 400); } catch { /* body unavailable */ }
    throw new Error(`OAuth token exchange failed (${response.status})${detail ? `：${detail}` : ''}`);
  }
  const json = await response.json() as { access_token: string; expires_in?: number };
  if (!json.access_token) throw new Error('OAuth token exchange returned no access token');
  return json;
}

/** Fetch the Google identity (email, name, picture) for a freshly minted access token. */
export async function googleUserInfo(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ email: string; name: string; picture: string }> {
  const response = await fetchImpl(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
  const json = await response.json() as { email?: string; name?: string; picture?: string };
  return { email: json.email ?? '', name: json.name ?? '', picture: json.picture ?? '' };
}
