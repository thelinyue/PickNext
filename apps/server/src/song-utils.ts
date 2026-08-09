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
 * 相似候选只用于提醒，不直接阻止新增。精确身份由调用方优先判断。
 * 同歌名、同歌手或互相包含时给出稳定分数，避免引入不可解释的模糊算法。
 */
export function similarityScore(left: SongIdentityInput, right: SongIdentityInput): number {
  const lt = normalizeIdentityPart(left.title);
  const la = normalizeIdentityPart(left.artist);
  const rt = normalizeIdentityPart(right.title);
  const ra = normalizeIdentityPart(right.artist);
  let score = 0;
  if (lt === rt) score += 3;
  else if (lt.includes(rt) || rt.includes(lt)) score += 1;
  if (la === ra) score += 3;
  else if (la.includes(ra) || ra.includes(la)) score += 1;
  return score;
}
