import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_AVATAR_BYTES = 1 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface StoredAvatar {
  path: string;
  mimeType: string;
}

function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  const png = bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return (mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg) || (mimeType === 'image/webp' && webp);
}

function decodeAvatarData(dataUrl: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/s.exec(dataUrl.trim());
  const mimeType = match?.[1];
  const encoded = match?.[2];
  if (!mimeType || !encoded || !SUPPORTED_MIME_TYPES.has(mimeType)) throw new Error('头像格式不受支持，请上传 JPG、PNG 或 WEBP 图片。');
  const bytes = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) throw new Error('头像不能为空，且大小不能超过 1 MB。');
  if (!hasImageSignature(bytes, mimeType)) throw new Error('头像图片内容无效，请重新选择图片。');
  return { bytes, mimeType };
}

/**
 * 用户头像只保存到 dataRoot/avatars，数据库保存路径和 MIME 类型。
 * 新文件先通过格式校验并原子写入，再由调用方更新数据库，避免资料更新时留下半个文件。
 */
export class ProfileStorage {
  constructor(private readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  save(userId: number, dataUrl: string): StoredAvatar {
    const { bytes, mimeType } = decodeAvatarData(dataUrl);
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const path = join(this.rootDirectory, `user-${userId}-${randomUUID()}.${extension}`);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, bytes);
    renameSync(temporaryPath, path);
    return { path, mimeType };
  }

  read(path: string): Buffer {
    return readFileSync(path);
  }

  remove(path: string | null | undefined): void {
    if (!path || !existsSync(path)) return;
    try { unlinkSync(path); } catch { /* 文件已被清理时不阻断资料更新。 */ }
  }
}
