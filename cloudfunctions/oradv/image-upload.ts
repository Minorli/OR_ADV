export interface ImageReadbackSdk {
  downloadFile?(input: { fileID: string }): Promise<{ statusCode: number; fileContent: Buffer }> | void;
  deleteFile(input: { fileList: string[] }): Promise<{ fileList: { fileID: string; status: number }[] }> | void;
}

/** Call only after matching the returned ID to the new, canonical upload path. */
export async function verifyNewImageUpload(sdk: ImageReadbackSdk, result: { fileID: string; statusCode: number }, image: Uint8Array, unavailable: string): Promise<void> {
  if (Number.isInteger(result.statusCode) && result.statusCode >= 200 && result.statusCode < 300) return;
  if (result.statusCode !== -1) throw new Error(unavailable);
  // wx-server-sdk 4.0.2 leaves -1 when node-sdk never invokes its response
  // callback. Accept that exact sentinel only after verifying the stored bytes.
  try {
    const downloaded = await sdk.downloadFile?.({ fileID: result.fileID });
    if (downloaded?.statusCode !== 200 || !Buffer.isBuffer(downloaded.fileContent)
      || downloaded.fileContent.length !== image.length || !downloaded.fileContent.equals(Buffer.from(image))) throw new Error(unavailable);
  } catch (error) {
    let removed = false;
    try {
      const cleanup = await sdk.deleteFile({ fileList: [result.fileID] });
      removed = !!cleanup?.fileList?.some(file => file.fileID === result.fileID && file.status === 0);
    } catch { /* Preserve the verification error; report cleanup separately. */ }
    if (!removed) console.error(JSON.stringify({ event: 'oradv_image_upload_cleanup_failed' }));
    throw error;
  }
}
