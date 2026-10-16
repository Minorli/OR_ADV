import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberMediaStorage, type MemberMediaCloudSdk } from '../../cloudfunctions/oradv/member-media-storage';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9RkAAAAASUVORK5CYII=';
const MEMBER = `member_${'a'.repeat(64)}`, ASSET = `media_${'b'.repeat(64)}`;
test('deliberately public club photos use opaque paths without private member or asset identifiers', async () => {
  let uploaded = '';
  const sdk: MemberMediaCloudSdk = {
    async uploadFile(input) { uploaded = input.cloudPath; return { fileID: `cloud://test.bucket/${uploaded}`, statusCode: 200 }; },
    async getTempFileURL(input) { return { fileList: [{ fileID: input.fileList[0].fileID, status: 0, tempFileURL: `https://cdn.example.test/${uploaded}` }] }; },
    async deleteFile(input) { return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) }; },
  };
  const provider = createMemberMediaStorage(sdk);
  const image = await provider.saveImage(MEMBER, ASSET, PNG, 'club_public');
  assert.match(uploaded, /^club-public-assets\/[a-f0-9-]{36}\.png$/);
  const url = await provider.url(image.fileId);
  assert.equal(url.includes(MEMBER), false); assert.equal(url.includes(ASSET), false);
  await provider.remove(image.fileId);
});
test('cloud evidence writes new server-only canonical objects, with no client upload ticket or video fallback', async () => {
  const stored = new Map<string, Buffer>(); let signed = 0, removed = 0;
  const sdk: MemberMediaCloudSdk = {
    async uploadFile(input) { stored.set(input.cloudPath, Buffer.from(input.fileContent)); return { fileID: `cloud://test.bucket/${input.cloudPath}`, statusCode: 200 }; },
    async getTempFileURL(input) { signed++; assert.equal(input.fileList[0].maxAge, 300); return { fileList: [{ fileID: input.fileList[0].fileID, status: 0, tempFileURL: 'https://private.example.test/image?signed' }] }; },
    async deleteFile(input) { removed++; return { fileList: input.fileList.map(fileID => ({ fileID, status: 0 })) }; },
  };
  const provider = createMemberMediaStorage(sdk);
  const first = await provider.saveImage(MEMBER, ASSET, PNG), second = await provider.saveImage(MEMBER, ASSET, PNG);
  assert.notEqual(first.fileId, second.fileId); assert.equal(provider.mode, 'cloud'); assert.equal(provider.saveVideo, undefined);
  assert.equal(first.bytes, Buffer.from(PNG, 'base64').length); assert.equal(first.mimeType, 'image/png');
  assert([...stored.keys()].every(path => path.startsWith(`member-evidence/${MEMBER}/${ASSET}/`) && path.endsWith('.png')));
  assert.equal(await provider.url(first.fileId), 'https://private.example.test/image?signed');
  for (const fileId of ['https://attacker.example/file', 'cloud://test.bucket/other-data/file.png', `cloud://test.bucket/member-evidence/${MEMBER}/${ASSET}/../other.png`]) {
    await assert.rejects(provider.url(fileId)); await assert.rejects(provider.remove(fileId));
  }
  assert.equal(signed, 1); assert.equal(removed, 0);
  await provider.remove(first.fileId); assert.equal(removed, 1);
  await assert.rejects(provider.saveImage('../someone', ASSET, PNG));
  await assert.rejects(provider.saveImage(MEMBER, ASSET, Buffer.alloc(65537).toString('base64')));
  assert.equal(stored.size, 2);
});

test('cloud evidence adapter rejects mismatched namespace, failed upload, invalid signatures and failed deletion', async () => {
  const sdk: MemberMediaCloudSdk = {
    async uploadFile() { return { fileID: 'cloud://test.bucket/other.png', statusCode: 200 }; },
    async getTempFileURL(input) { return { fileList: [{ fileID: input.fileList[0].fileID, status: -1, tempFileURL: 'https://private.example.test/' }] }; },
    async deleteFile(input) { return { fileList: input.fileList.map(fileID => ({ fileID, status: -1 })) }; },
  };
  const provider = createMemberMediaStorage(sdk);
  await assert.rejects(provider.saveImage(MEMBER, ASSET, PNG));
  const valid = `cloud://test.bucket/member-evidence/${MEMBER}/${ASSET}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png`;
  await assert.rejects(provider.url(valid)); await assert.rejects(provider.remove(valid));
  sdk.getTempFileURL = async input => ({ fileList: [{ fileID: input.fileList[0].fileID, status: 0, tempFileURL: 'http://untrusted/image' }] });
  await assert.rejects(provider.url(valid));
});
