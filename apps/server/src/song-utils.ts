import { pinyin } from 'pinyin-pro';

export interface SongIdentityInput {
  title: string;
  artist: string;
  version?: string | null | undefined;
}

/**
 * 生成曲库排序所需的全拼和首字母。
 * 中文交给 pinyin-pro，英文会统一去音标；数字、符号及无法识别的内容归入 # 组。
 */
export function buildSongIndex(title: string): { pinyin: string; titleInitial: string } {
  const full = pinyin(title.normalize('NFKC'), { toneType: 'none', type: 'array' })
    .join(' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  const leading = title.normalize('NFKC').trim().charAt(0);
  const latinLeading = leading.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]/i)?.[0];
  const hanLeading = /\p{Script=Han}/u.test(leading)
    ? pinyin(leading, { toneType: 'none' }).match(/[a-z]/i)?.[0]
    : undefined;
  const first = (latinLeading ?? hanLeading)?.toUpperCase();
  return { pinyin: full || title.toLowerCase(), titleInitial: first ?? '#' };
}

/** 精确重复判断会忽略常见排版差异，但仍把版本作为歌曲身份的一部分。 */
export function normalizeIdentityPart(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function songIdentityKey(song: SongIdentityInput): string {
  return [song.title, song.artist, song.version].map(normalizeIdentityPart).join('|');
}

/**
 * 返回可直接写入数据库索引列的歌曲身份组成部分。
 * 三个字段分开保存，既便于精确查重，也避免每次查询都在应用层扫描整张歌曲表。
 */
export function normalizedSongIdentity(song: SongIdentityInput): {
  title: string;
  artist: string;
  version: string;
} {
  return {
    title: normalizeIdentityPart(song.title),
    artist: normalizeIdentityPart(song.artist),
    version: normalizeIdentityPart(song.version)
  };
}

/**
 * 相似候选只用于提醒，不直接阻止新增。精确身份由调用方优先判断。
 * 这里只依据歌名相同或互相包含计算分数；同一歌手本身不能说明是重复歌曲。
 */
export function similarityScore(left: SongIdentityInput, right: SongIdentityInput): number {
  const lt = normalizeIdentityPart(left.title);
  const rt = normalizeIdentityPart(right.title);
  if (lt === rt) return 4;
  if (lt.includes(rt) || rt.includes(lt)) return 3;
  return 0;
}
