import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createAvatarStorage, type AvatarCloudSdk } from '../../cloudfunctions/oradv/avatar-storage';
import { createMemberMediaStorage, type MemberMediaCloudSdk } from '../../cloudfunctions/oradv/member-media-storage';

const fromFunction = createRequire(resolve('cloudfunctions/oradv/package.json'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
const BYTES = Buffer.from(PNG, 'base64'), MEMBER = `member_${'a'.repeat(64)}`, ASSET = `media_${'b'.repeat(64)}`;
type UploadSdk = AvatarCloudSdk & MemberMediaCloudSdk & { downloadFile?: (input: { fileID: string }) => Promise<{ statusCode: number; fileContent: Buffer }> };
const save = async (sdk: UploadSdk, kind: 'avatar' | 'evidence' | 'public') => kind === 'avatar'
  ? createAvatarStorage(sdk).save(MEMBER, PNG)
  : (await createMemberMediaStorage(sdk).saveImage(MEMBER, ASSET, PNG, kind === 'public' ? 'club_public' : 'dossier')).fileId;
function storage(statusCode = -1) {
  const uploaded = new Map<string, Buffer>(), downloaded: string[] = [], deleted: string[] = [];
  const sdk: UploadSdk = {
    async uploadFile(input) { const fileID = `cloud://offline.bucket/${input.cloudPath}`; uploaded.set(fileID, Buffer.from(input.fileContent)); return { fileID, statusCode }; },
    async downloadFile(input) { downloaded.push(input.fileID); return { statusCode: 200, fileContent: Buffer.from(uploaded.get(input.fileID)!) }; },
    async getTempFileURL() { return { fileList: [] }; },
    async deleteFile(input) { deleted.push(...input.fileList); for (const id of input.fileList) uploaded.delete(id); return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) }; },
  };
  return { sdk, uploaded, downloaded, deleted };
}

test('installed wx SDK leaves upload status at -1 when its raw provider never invokes the response callback', async () => {
  const cloudModule = fromFunction('wx-server-sdk'); assert.equal(fromFunction('wx-server-sdk/package.json').version, '4.0.2');
  const cloud = cloudModule.createNewInstance({ env: 'offline-upload-compat' });
  let rawCalls = 0;
  cloud.registerService({ createService(internal: any) {
    internal.getInstanceForEnv = () => ({ async uploadFile(input: any, options: any) {
      rawCalls++; assert.equal(typeof options.onResponseReceived, 'function');
      assert.deepEqual(input.fileContent, BYTES); return { fileID: `cloud://offline.bucket/${input.cloudPath}` };
    } });
    return { name: 'offlineUploadBoundary', getAPIs: () => ({}) };
  } });
  const result = await cloud.uploadFile({ cloudPath: 'sdk-sentinel.png', fileContent: BYTES });
  assert.equal(rawCalls, 1); assert.equal(result.statusCode, -1); assert.equal(result.fileID, 'cloud://offline.bucket/sdk-sentinel.png');
  assert.equal(result.errMsg, 'uploadFile:ok');
});

test('avatar, private evidence and public images accept exact -1 only after downloading matching validated image bytes', async () => {
  for (const kind of ['avatar', 'evidence', 'public'] as const) {
    const env = storage(), fileID = await save(env.sdk, kind);
    assert.deepEqual(env.downloaded, [fileID]); assert.deepEqual(env.uploaded.get(fileID), BYTES); assert.deepEqual(env.deleted, []);
    assert.match(fileID, kind === 'avatar' ? /\/member-avatars\// : kind === 'evidence' ? /\/member-evidence\// : /\/club-public-assets\//);
  }
});

test('ordinary 2xx uploads avoid compatibility downloads and cleanup', async () => {
  for (const kind of ['avatar', 'evidence', 'public'] as const) {
    const env = storage(201), fileID = await save(env.sdk, kind);
    assert(env.uploaded.has(fileID)); assert.deepEqual(env.downloaded, []); assert.deepEqual(env.deleted, []);
    delete env.sdk.downloadFile; assert(await save(env.sdk, kind), 'existing adapters without download support retain the 2xx path');
  }
});

test('undefined, nonnumeric and other failed upload statuses never use the -1 compatibility path', async () => {
  for (const kind of ['avatar', 'evidence'] as const) {
    for (const status of [undefined, null, '200', NaN, -2, 0, 199, 300, 403, 500]) {
      const env = storage(status as number);
      // Omitted input must differ from the helper's default sentinel.
      env.sdk.uploadFile = async input => ({ fileID: `cloud://offline.bucket/${input.cloudPath}`, statusCode: status as number });
      await assert.rejects(save(env.sdk, kind)); assert.deepEqual(env.downloaded, []);
    }
  }
});

test('failed readback removes only the new canonical file and preserves errors even when cleanup fails', async () => {
  for (const kind of ['avatar', 'evidence', 'public'] as const) {
    for (const failure of ['wrong-bytes', 'wrong-length', 'bad-status', 'no-download', 'throw'] as const) {
      const env = storage(), original = new Error('readback failure');
      if (failure === 'no-download') delete env.sdk.downloadFile;
      else env.sdk.downloadFile = async () => {
        if (failure === 'throw') throw original;
        return { statusCode: failure === 'bad-status' ? 403 : 200,
          fileContent: failure === 'wrong-length' ? Buffer.concat([BYTES, Buffer.from([0])]) : failure === 'wrong-bytes' ? Buffer.from(BYTES).fill(0, 1, 2) : BYTES };
      };
      await assert.rejects(save(env.sdk, kind), error => failure !== 'throw' || error === original);
      assert.equal(env.deleted.length, 1); assert.equal(env.uploaded.size, 0); assert.match(env.deleted[0], /^cloud:\/\/offline.bucket\//);
    }
    const env = storage(), original = new Error('original readback failure'), previousError = console.error, logged: unknown[][] = [];
    env.sdk.downloadFile = async () => { throw original; }; env.sdk.deleteFile = async () => { throw new Error('cleanup failure'); };
    console.error = (...args) => { logged.push(args); };
    try { await assert.rejects(save(env.sdk, kind), error => error === original); }
    finally { console.error = previousError; }
    assert.equal(logged.length, 1); assert.equal(JSON.stringify(logged).includes(MEMBER), false); assert.equal(JSON.stringify(logged).includes('cloud://'), false);
  }
});

test('a returned file outside the generated path is never downloaded or deleted', async () => {
  for (const kind of ['avatar', 'evidence', 'public'] as const) {
    const env = storage(); env.sdk.uploadFile = async () => ({ fileID: 'cloud://offline.bucket/someone-else.png', statusCode: -1 });
    await assert.rejects(save(env.sdk, kind)); assert.deepEqual(env.downloaded, []); assert.deepEqual(env.deleted, []);
  }
});
