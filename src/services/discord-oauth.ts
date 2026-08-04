import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/v10/oauth2/token/revoke';
const USER_URL = 'https://discord.com/api/v10/users/@me';

/** `identify` for the user id/name, `email` for the address we match on. */
const SCOPES = 'identify email';

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export class OAuthError extends Error {}

export function redirectUri(): string {
  return `${config.publicBaseUrl}/auth/discord/callback`;
}

export function authorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.discordClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  // Always show the consent screen so a shared browser cannot silently reuse
  // the previous person's Discord session.
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
}

export async function exchangeCode(code: string): Promise<string> {
  let res: Response;
  try {
    res = await postForm(TOKEN_URL, {
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    });
  } catch (err) {
    throw new OAuthError(`Discord への接続に失敗しました: ${(err as Error).message}`);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // The body can name the exact misconfiguration (bad secret, redirect mismatch).
    logger.error(`discord token exchange failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    if (text.includes('invalid_client')) {
      // Almost always a mis-pasted secret, so say what to check.
      const len = config.discordClientSecret.length;
      const hint =
        len === 32
          ? 'Discord 側で Reset Secret を行い、新しい値で設定し直してください。'
          : `現在保存されているシークレットは ${len} 文字です（正しくは 32 文字）。貼り付け時に文字が欠けたか余分に混入しています。`;
      throw new OAuthError(
        `Discord アプリのクライアントIDまたはシークレットが正しくありません。${hint}` +
          '（サーバーで deploy/set-discord-auth.sh を再実行してください）',
      );
    }
    if (text.includes('redirect_uri')) {
      throw new OAuthError(
        `Discord アプリの Redirect URI が一致しません。開発者ポータルに ${redirectUri()} を登録してください。`,
      );
    }
    throw new OAuthError(`Discord の認証に失敗しました (HTTP ${res.status})`);
  }

  const token = (JSON.parse(text) as { access_token?: string }).access_token;
  if (!token) throw new OAuthError('Discord からアクセストークンを取得できませんでした');
  return token;
}

export async function fetchProfile(accessToken: string): Promise<DiscordProfile> {
  const res = await fetch(USER_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new OAuthError(`Discord のユーザー情報を取得できませんでした (HTTP ${res.status})`);
  }
  const u = (await res.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
    email?: string | null;
    verified?: boolean;
    avatar?: string | null;
  };
  return {
    id: u.id,
    username: u.username,
    globalName: u.global_name ?? null,
    email: u.email ? u.email.trim().toLowerCase() : null,
    emailVerified: u.verified === true,
    avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
  };
}

/**
 * We only needed the token to read the profile once; hand it back to Discord so
 * a leaked log line cannot be replayed. Failure here is not worth surfacing.
 */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    await postForm(REVOKE_URL, {
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      token: accessToken,
    });
  } catch (err) {
    logger.debug(`discord token revoke failed (ignored): ${(err as Error).message}`);
  }
}
