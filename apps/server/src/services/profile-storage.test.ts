import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileStorage } from './profile-storage.js';

const directories: string[] = [];

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('用户头像存储', () => {
  it('校验图片签名并写入头像文件', () => {
    const directory = mkdtempSync(join(tmpdir(), 'picknext-profile-')); directories.push(directory);
    const storage = new ProfileStorage(directory);
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const saved = storage.save(7, png);
    expect(saved.mimeType).toBe('image/png');
    expect(readFileSync(saved.path)).toHaveLength(8);
    expect(readdirSync(directory)).toHaveLength(1);
    expect(() => storage.save(7, 'data:image/png;base64,AQID')).toThrow('图片内容无效');
  });
});
