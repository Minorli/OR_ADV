import { createHash, createHmac } from 'node:crypto';
import type { AvatarCloudSdk } from './avatar-storage';
import type { MemberMediaCloudSdk } from './member-media-storage';

const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');
const hmacSha256 = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

function signTc3ClientCredential(secretId: string, secretKey: string, domain: string, pathname: string, jsonBody: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json\nhost:${domain.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n${pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256Hex(jsonBody)}`;
  const credentialScope = `${date}/tcb/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretSigning = hmacSha256(hmacSha256(hmacSha256(`TC3${secretKey}`, date), 'tcb'), 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const ALLOWED_BUCKETS = new Set(['member-avatars', 'member-evidence', 'club-public-assets']);
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_MAX_CACHE_MS = 10 * 60_000;

export type UnifiedStorageSdk = AvatarCloudSdk & MemberMediaCloudSdk & {
  downloadFile(input: { fileID: string }): Promise<{ statusCode: number; fileContent: Buffer }>;
};

export interface PgStorageCredentials {
  apiKey?: string;
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
}

export interface PgCompatibleStorageOptions {
  envId: () => string | undefined;
  classicSdk?: Partial<UnifiedStorageSdk>;
  credentials?: () => PgStorageCredentials;
  fetchImpl?: typeof fetch;
  forcePg?: boolean;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function splitBucketPath(cloudPath: string): { bucketId: string; objectKey: string } {
  const normalized = cloudPath.replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) throw new Error('Invalid storage path');
  const bucketId = normalized.slice(0, slash);
  const objectKey = normalized.slice(slash + 1);
  if (!ALLOWED_BUCKETS.has(bucketId) || !objectKey || objectKey.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid storage bucket or object key');
  }
  return { bucketId, objectKey };
}

export function parseCloudFileId(fileId: string): { envOrHost: string; bucketId: string; objectKey: string } {
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileId);
  if (!match) throw new Error('Invalid cloud file reference');
  const { bucketId, objectKey } = splitBucketPath(match[2]);
  return { envOrHost: match[1], bucketId, objectKey };
}

function isPgUpgradeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; errCode?: unknown; message?: unknown; errMsg?: unknown };
  const text = `${String(record.code ?? '')} ${String(record.errCode ?? '')} ${String(record.message ?? '')} ${String(record.errMsg ?? '')}`;
  return /SDK_UPGRADE_REQUIRED|not supported in PostgreSQL environments|STORAGE_LEGACY_NOT_SUPPORTED/i.test(text);
}

export function createPgCompatibleStorageSdk(options: PgCompatibleStorageOptions): UnifiedStorageSdk {
  const fetchFn = options.fetchImpl ?? fetch;
  let pgLatched = options.forcePg === true;
  let cachedToken = '';
  let cachedTokenKey = '';
  let cachedUntil = 0;

  const readEnvId = (): string => {
    const envId = options.envId();
    if (!envId || !/^[a-zA-Z0-9_-]{5,100}$/.test(envId)) throw new Error('Storage environment unavailable');
    return envId;
  };

  const readCredentials = (): PgStorageCredentials => options.credentials?.() ?? {
    apiKey: process.env.CLOUDBASE_APIKEY,
    secretId: process.env.TENCENTCLOUD_SECRETID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY,
    sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
  };

  const getAccessToken = async (forceRefresh = false): Promise<string> => {
    const envId = readEnvId();
    const creds = readCredentials();
    if (typeof creds.apiKey === 'string' && creds.apiKey.trim()) return creds.apiKey.trim();
    if (!creds.secretId || !creds.secretKey) throw new Error('Storage credentials unavailable');
    const cacheIdentity = `${envId}:${creds.secretId}:${creds.sessionToken ?? ''}`;
    const now = Date.now();
    if (!forceRefresh && cachedToken && cachedTokenKey === cacheIdentity && now < cachedUntil) return cachedToken;

    const domain = `${envId}.api.tcloudbasegateway.com`;
    const pathname = '/auth/v1/token/clientCredential';
    const url = `https://${domain}${pathname}`;
    const jsonBody = JSON.stringify({ grant_type: 'client_credentials' });
    const timestamp = Math.floor(now / 1000) - 1;
    const authorization = signTc3ClientCredential(creds.secretId, creds.secretKey, domain, pathname, jsonBody, timestamp);
    const requiredHeaders = { Host: domain, 'Content-Type': 'application/json' };
    const authHeader = creds.sessionToken
      ? `${authorization}, Timestamp=${timestamp}, Token=${creds.sessionToken}`
      : `${authorization}, Timestamp=${timestamp}`;
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { ...requiredHeaders, Authorization: authHeader },
      body: jsonBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Storage token exchange failed (${response.status})`);
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload?.access_token !== 'string' || !payload.access_token) throw new Error('Storage access token missing');
    const expiresInSec = typeof payload.expires_in === 'number' && payload.expires_in > 90 ? payload.expires_in : 600;
    cachedToken = payload.access_token;
    cachedTokenKey = cacheIdentity;
    cachedUntil = now + Math.min((expiresInSec - 60) * 1000, TOKEN_MAX_CACHE_MS);
    return cachedToken;
  };

  const authedFetch = async (path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<{ envId: string; baseUrl: string; response: Response }> => {
    const envId = readEnvId();
    const baseUrl = `https://${envId}.api.tcloudbasegateway.com/v1/storages`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken(attempt > 0);
      const response = await fetchFn(`${baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 && attempt === 0) { cachedToken = ''; continue; }
      return { envId, baseUrl, response };
    }
    throw new Error('Storage authentication failed');
  };

  const withFallback = async <T>(classicCall: (() => Promise<T>) | undefined, pgCall: () => Promise<T>): Promise<T> => {
    if (!pgLatched && classicCall) {
      try { return await classicCall(); }
      catch (error) {
        if (!isPgUpgradeError(error)) throw error;
        pgLatched = true;
      }
    }
    return pgCall();
  };

  return {
    async uploadFile(input) {
      const { bucketId, objectKey } = splitBucketPath(input.cloudPath);
      const contentType = objectKey.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const classic = options.classicSdk?.uploadFile;
      return withFallback(
        classic ? () => classic(input) : undefined,
        async () => {
          const { envId, response } = await authedFetch(`/object/${encodeURIComponent(bucketId)}/${encodeObjectKey(objectKey)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(input.fileContent.length),
              'Cache-Control': 'max-age=300',
            },
            body: new Uint8Array(input.fileContent),
          });
          if (!response.ok) throw new Error(`PG storage upload failed (${response.status})`);
          const data = await response.json() as { Key?: unknown };
          const expectedKey = `${bucketId}/${objectKey}`;
          if (typeof data?.Key === 'string' && data.Key !== expectedKey && data.Key !== objectKey) {
            throw new Error('Unexpected PG storage object key');
          }
          return { fileID: `cloud://${envId}/${bucketId}/${objectKey}`, statusCode: response.status };
        },
      );
    },

    async downloadFile(input) {
      const { bucketId, objectKey } = parseCloudFileId(input.fileID);
      const classic = options.classicSdk?.downloadFile;
      return withFallback(
        classic ? async () => {
          const out = await classic(input);
          if (!out) throw new Error('Empty download result');
          return out;
        } : undefined,
        async () => {
          const { response } = await authedFetch(`/object/${encodeURIComponent(bucketId)}/${encodeObjectKey(objectKey)}`, { method: 'GET' });
          if (!response.ok) return { statusCode: response.status, fileContent: Buffer.alloc(0) };
          const arrayBuffer = await response.arrayBuffer();
          return { statusCode: response.status, fileContent: Buffer.from(arrayBuffer) };
        },
      );
    },

    async getTempFileURL(input) {
      const classic = options.classicSdk?.getTempFileURL;
      return withFallback(
        classic ? async () => {
          const out = await classic(input);
          if (!out) throw new Error('Empty signed URL result');
          if (out.fileList?.some(item => item.status !== 0 && /SDK_UPGRADE_REQUIRED|PostgreSQL/i.test(String((item as { errMsg?: unknown }).errMsg ?? '')))) {
            const upgradeError = new Error('SDK_UPGRADE_REQUIRED: PostgreSQL environments');
            throw upgradeError;
          }
          return out;
        } : undefined,
        async () => {
          const fileList = await Promise.all(input.fileList.map(async entry => {
            const { bucketId, objectKey } = parseCloudFileId(entry.fileID);
            const expiresIn = Math.max(60, Math.floor(entry.maxAge || 300));
            const { baseUrl, response } = await authedFetch(`/object/sign/${encodeURIComponent(bucketId)}/${encodeObjectKey(objectKey)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expiresIn }),
            });
            if (!response.ok) return { fileID: entry.fileID, status: response.status, tempFileURL: '' };
            const data = await response.json() as { fullSignedURL?: unknown; signedURL?: unknown };
            const rawSigned = typeof data?.fullSignedURL === 'string' && data.fullSignedURL
              ? data.fullSignedURL
              : typeof data?.signedURL === 'string' && data.signedURL
                ? `${baseUrl}${data.signedURL.startsWith('/') ? '' : '/'}${data.signedURL}`
                : '';
            return { fileID: entry.fileID, status: rawSigned ? 0 : -1, tempFileURL: rawSigned };
          }));
          return { fileList };
        },
      );
    },

    async deleteFile(input) {
      const classic = options.classicSdk?.deleteFile;
      return withFallback(
        classic ? async () => {
          const out = await classic(input);
          if (!out) throw new Error('Empty delete result');
          if (out.fileList?.some(item => item.status !== 0 && /SDK_UPGRADE_REQUIRED|PostgreSQL/i.test(String((item as { errMsg?: unknown }).errMsg ?? '')))) {
            throw new Error('SDK_UPGRADE_REQUIRED: PostgreSQL environments');
          }
          return out;
        } : undefined,
        async () => {
          const grouped = new Map<string, { fileID: string; objectKey: string }[]>();
          for (const fileID of input.fileList) {
            const { bucketId, objectKey } = parseCloudFileId(fileID);
            const bucketItems = grouped.get(bucketId) ?? [];
            bucketItems.push({ fileID, objectKey });
            grouped.set(bucketId, bucketItems);
          }
          const statuses = new Map<string, number>();
          for (const [bucketId, entries] of grouped.entries()) {
            const { response } = await authedFetch(`/object/${encodeURIComponent(bucketId)}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prefixes: entries.map(item => item.objectKey) }),
            });
            const status = response.ok ? 0 : response.status;
            for (const item of entries) statuses.set(item.fileID, status);
          }
          return { fileList: input.fileList.map(fileID => ({ fileID, status: statuses.get(fileID) ?? -1 })) };
        },
      );
    },
  };
}
