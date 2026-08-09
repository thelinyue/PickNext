import type { PickFilters, PickSource } from '@picknext/shared';

export const PICK_ALGORITHM_VERSION = 'v1';

export interface PickCandidate {
  id: number;
  artists: string[];
  language: string | null;
  genre: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  performanceType: 'solo' | 'duet' | 'chorus';
  rating: number | null;
  lastPlayedAt: string | null;
}

export interface WeightedQueueItem {
  songId: number;
  position: number;
  recencyWeight: number;
  artistFactor: number;
  genreFactor: number;
  difficultyFactor: number;
  finalWeight: number;
}

export interface CandidatePools {
  ktv: PickCandidate[];
  repertoire: PickCandidate[];
  global: PickCandidate[];
  repertoireTotal: number;
}

export interface PoolSelection {
  source: PickSource | null;
  candidates: PickCandidate[];
  recentFilterRelaxed: boolean;
}

/**
 * 使用轻量 Mulberry32 随机数生成器，使同一场次的随机种子可复现。
 * 它只服务产品随机排序，不用于密码、令牌等安全场景。
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 只反映距上次实际唱完的时间，确保最近唱过的歌曲仍有非零机会。 */
export function recencyWeight(lastPlayedAt: string | null, now = new Date()): number {
  if (!lastPlayedAt) return 3;
  const played = new Date(lastPlayedAt);
  const days = Math.max(0, (now.getTime() - played.getTime()) / 86_400_000);
  if (days <= 30) return 1 + days / 30;
  if (days <= 60) return 2 + (days - 30) / 30;
  return 3;
}

export function matchesFilters(candidate: PickCandidate, filters: PickFilters): boolean {
  return (
    (filters.languages.length === 0 || (candidate.language !== null && filters.languages.includes(candidate.language))) &&
    (filters.genres.length === 0 || (candidate.genre !== null && filters.genres.includes(candidate.genre))) &&
    (filters.difficulties.length === 0 || (candidate.difficulty !== null && filters.difficulties.includes(candidate.difficulty))) &&
    (filters.ratings.length === 0 || (candidate.rating !== null && filters.ratings.includes(candidate.rating))) &&
    (filters.performanceTypes.length === 0 || filters.performanceTypes.includes(candidate.performanceType))
  );
}

/**
 * 严格按 KTV → 会唱曲库 → 空曲库冷启动选择来源。
 * 最近十首只在它单独造成当前来源空池时放宽；本场去重必须在调用前完成，永不放宽。
 */
export function selectCandidatePool(
  pools: CandidatePools,
  filters: PickFilters,
  recentSongIds: ReadonlySet<number>,
  avoidRecent: boolean,
  forceRepertoire = false
): PoolSelection {
  const filtered = (items: PickCandidate[]) => items.filter((song) => matchesFilters(song, filters));
  const sources: Array<[PickSource, PickCandidate[]]> = forceRepertoire
    ? [['repertoire', filtered(pools.repertoire)]]
    : [
        ['ktv', filtered(pools.ktv)],
        ['repertoire', filtered(pools.repertoire)]
      ];

  if (pools.repertoireTotal === 0 && !forceRepertoire) {
    sources.push(['global', filtered(pools.global)]);
  }

  for (const [source, beforeRecent] of sources) {
    if (beforeRecent.length === 0) continue;
    if (!avoidRecent) return { source, candidates: beforeRecent, recentFilterRelaxed: false };
    const afterRecent = beforeRecent.filter((song) => !recentSongIds.has(song.id));
    return afterRecent.length > 0
      ? { source, candidates: afterRecent, recentFilterRelaxed: false }
      : { source, candidates: beforeRecent, recentFilterRelaxed: true };
  }
  return { source: null, candidates: [], recentFilterRelaxed: false };
}

/**
 * 构造加权无放回队列。每轮都根据上一首临时计算多样性因子；因子永远大于零，
 * 因而单歌手、单曲风或全困难候选池不会被错误清空。
 */
export function buildWeightedQueue(
  candidates: readonly PickCandidate[],
  random: () => number,
  now = new Date()
): WeightedQueueItem[] {
  const remaining = [...candidates];
  const result: WeightedQueueItem[] = [];
  let previous: PickCandidate | undefined;

  while (remaining.length > 0) {
    const weighted = remaining.map((candidate) => {
      const base = recencyWeight(candidate.lastPlayedAt, now);
      const sameArtist = previous?.artists.some((artist) => candidate.artists.includes(artist)) ?? false;
      const artistFactor = sameArtist ? 0.35 : 1;
      const genreFactor = previous?.genre !== null && previous?.genre === candidate.genre ? 0.7 : 1;
      const difficultyFactor = previous?.difficulty === 'hard' && candidate.difficulty === 'hard' ? 0.6 : 1;
      return {
        candidate,
        recencyWeight: base,
        artistFactor,
        genreFactor,
        difficultyFactor,
        finalWeight: base * artistFactor * genreFactor * difficultyFactor
      };
    });
    const total = weighted.reduce((sum, item) => sum + item.finalWeight, 0);
    let threshold = random() * total;
    let selected = weighted[weighted.length - 1]!;
    for (const item of weighted) {
      threshold -= item.finalWeight;
      if (threshold < 0) {
        selected = item;
        break;
      }
    }
    result.push({
      songId: selected.candidate.id,
      position: result.length,
      recencyWeight: selected.recencyWeight,
      artistFactor: selected.artistFactor,
      genreFactor: selected.genreFactor,
      difficultyFactor: selected.difficultyFactor,
      finalWeight: selected.finalWeight
    });
    remaining.splice(remaining.findIndex((item) => item.id === selected.candidate.id), 1);
    previous = selected.candidate;
  }
  return result;
}
