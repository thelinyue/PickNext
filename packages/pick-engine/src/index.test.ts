import { describe, expect, it } from 'vitest';
import { buildWeightedQueue, createSeededRandom, recencyWeight, selectCandidatePool, type PickCandidate } from './index.js';

const candidate = (id: number, patch: Partial<PickCandidate> = {}): PickCandidate => ({
  id,
  artists: [`歌手${id}`],
  language: '国语',
  genre: '流行',
  difficulty: 'medium',
  performanceType: 'solo',
  rating: 4,
  lastPlayedAt: null,
  ...patch
});
const filters = { languages: [], genres: [], difficulties: [], ratings: [], performanceTypes: [] };

describe('Pick 引擎', () => {
  it('固定种子可复现且无重复', () => {
    const songs = Array.from({ length: 50 }, (_, index) => candidate(index + 1));
    const first = buildWeightedQueue(songs, createSeededRandom(42));
    const second = buildWeightedQueue(songs, createSeededRandom(42));
    expect(first).toEqual(second);
    expect(new Set(first.map((item) => item.songId))).toHaveLength(50);
    expect(first.every((item) => item.finalWeight > 0)).toBe(true);
  });

  it('久未唱权重单调不下降', () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const values = [0, 15, 30, 45, 60, 90].map((days) =>
      recencyWeight(new Date(now.getTime() - days * 86_400_000).toISOString(), now)
    );
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(recencyWeight(null, now)).toBe(3);
  });

  it('优先 KTV，且最近限制单独造成空池时才放宽', () => {
    const pool = selectCandidatePool(
      { ktv: [candidate(1)], repertoire: [candidate(2)], global: [candidate(3)], repertoireTotal: 1 },
      filters,
      new Set([1]),
      true
    );
    expect(pool.source).toBe('ktv');
    expect(pool.recentFilterRelaxed).toBe(true);
    expect(pool.candidates[0]?.id).toBe(1);
  });

  it('会唱曲库非空但筛选无结果时不使用全部曲库', () => {
    const pool = selectCandidatePool(
      { ktv: [], repertoire: [candidate(1)], global: [candidate(2, { language: '粤语' })], repertoireTotal: 1 },
      { ...filters, languages: ['粤语'] },
      new Set(),
      false
    );
    expect(pool.source).toBeNull();
  });

  it('1000 首候选可在目标时间内生成', () => {
    const songs = Array.from({ length: 1000 }, (_, index) => candidate(index + 1));
    const started = Date.now();
    buildWeightedQueue(songs, createSeededRandom(7));
    expect(Date.now() - started).toBeLessThan(100);
  });
});
