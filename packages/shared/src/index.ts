import { z } from 'zod';

export const collectionTypeSchema = z.enum(['repertoire', 'learning']);
export type CollectionType = z.infer<typeof collectionTypeSchema>;

export const pickSourceSchema = z.enum(['ktv', 'repertoire', 'global']);
export type PickSource = z.infer<typeof pickSourceSchema>;

export const pickQueueStatusSchema = z.enum([
  'pending',
  'picked',
  'skipped',
  'played',
  'invalidated'
]);
export type PickQueueStatus = z.infer<typeof pickQueueStatusSchema>;

export const difficultySchema = z.enum(['easy', 'medium', 'hard']);
export const performanceTypeSchema = z.enum(['solo', 'duet', 'chorus']);
export type Difficulty = z.infer<typeof difficultySchema>;
export type PerformanceType = z.infer<typeof performanceTypeSchema>;

export const songListScopeSchema = z.enum(['personal', 'global']);
export type SongListScope = z.infer<typeof songListScopeSchema>;

export const librarySceneSchema = z.enum(['all', 'strong', 'challenge', 'recent', 'note', 'new', 'high', 'hard', 'custom']);
export type LibraryScene = z.infer<typeof librarySceneSchema>;

const csvStringsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(','));
  if (typeof value === 'string' && value) return value.split(',');
  return [];
}, z.array(z.string().trim().min(1)).max(20).default([]));

const csvDifficultiesSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(','));
  if (typeof value === 'string' && value) return value.split(',');
  return [];
}, z.array(difficultySchema).max(3).default([]));

export const searchSongsQuerySchema = z.object({
  scope: songListScopeSchema.default('global'),
  collection: collectionTypeSchema.optional(),
  q: z.string().trim().max(200).default(''),
  languages: csvStringsSchema,
  genres: csvStringsSchema,
  difficulties: csvDifficultiesSchema,
  minRating: z.preprocess((value) => value === '' || value === undefined ? undefined : value, z.coerce.number().int().min(1).max(5).optional()),
  scene: librarySceneSchema.default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0)
}).superRefine((value, context) => {
  if (value.scope === 'personal' && !value.collection) {
    context.addIssue({ code: 'custom', path: ['collection'], message: '查询个人曲库时必须指定会唱或待学。' });
  }
  if (value.scope === 'global' && value.collection) {
    context.addIssue({ code: 'custom', path: ['collection'], message: '全部曲库不能使用个人收录状态筛选。' });
  }
});

const songListBaseSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  artist: z.string(),
  version: z.string().nullable(),
  language: z.string().nullable(),
  genre: z.string().nullable(),
  performanceType: performanceTypeSchema,
  titleInitial: z.string().regex(/^[A-Z#]$/)
});

export const personalSongListItemSchema = songListBaseSchema.extend({
  scope: z.literal('personal'),
  collectionType: collectionTypeSchema,
  personalDifficulty: difficultySchema.nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  keyShift: z.number().int().min(-12).max(12).nullable(),
  playCount: z.number().int().nonnegative(),
  lastPlayedAt: z.string().nullable(),
  hasLyrics: z.boolean(),
  hasNote: z.boolean(),
  hasMemoryCue: z.boolean(),
  snoozedUntil: z.string().nullable()
});

export const globalSongListItemSchema = songListBaseSchema.extend({
  scope: z.literal('global'),
  collectionType: collectionTypeSchema.nullable(),
  referenceDifficulty: difficultySchema.nullable(),
  aggregateRating: z.number().min(1).max(5).nullable(),
  aggregateRatingCount: z.number().int().min(3).nullable()
});

export const songListItemSchema = z.discriminatedUnion('scope', [personalSongListItemSchema, globalSongListItemSchema]);
export type PersonalSongListItem = z.infer<typeof personalSongListItemSchema>;
export type GlobalSongListItem = z.infer<typeof globalSongListItemSchema>;
export type SongListItem = z.infer<typeof songListItemSchema>;

export const songLibraryCountsSchema = z.object({
  personal: z.number().int().nonnegative(),
  repertoire: z.number().int().nonnegative(),
  learning: z.number().int().nonnegative(),
  global: z.number().int().nonnegative()
});

export const searchSongsResponseSchema = z.object({
  songs: z.array(songListItemSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  counts: songLibraryCountsSchema,
  facets: z.object({ languages: z.array(z.string()), genres: z.array(z.string()) }),
  alphabetIndex: z.array(z.object({
    initial: z.string().regex(/^[A-Z#]$/),
    count: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative()
  }))
});
export type SearchSongsResponse = z.infer<typeof searchSongsResponseSchema>;

export interface LibraryFilters {
  languages: string[];
  genres: string[];
  difficulties: Difficulty[];
  minRating?: number;
  scene: LibraryScene;
}

export interface AlphabetIndexItem {
  initial: string;
  count: number;
  offset: number;
}

export const pickFiltersSchema = z.object({
  languages: z.array(z.string().min(1)).max(20).default([]),
  genres: z.array(z.string().min(1)).max(20).default([]),
  difficulties: z.array(difficultySchema).max(3).default([]),
  ratings: z.array(z.number().int().min(1).max(5)).max(5).default([]),
  performanceTypes: z.array(performanceTypeSchema).max(3).default([])
});
export type PickFilters = z.infer<typeof pickFiltersSchema>;

export const pickRequestSchema = z.object({
  requestId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  currentEventId: z.string().uuid().optional(),
  avoidRecent: z.boolean().default(true),
  continueFromRepertoire: z.boolean().default(false),
  filters: pickFiltersSchema.default({
    languages: [],
    genres: [],
    difficulties: [],
    ratings: [],
    performanceTypes: []
  })
});
export type PickRequest = z.infer<typeof pickRequestSchema>;

export const pickedSongSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  artist: z.string(),
  version: z.string().nullable(),
  language: z.string().nullable(),
  genre: z.string().nullable(),
  difficulty: difficultySchema.nullable(),
  performanceType: performanceTypeSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  keyShift: z.number().int().min(-12).max(12).nullable()
});

export const pickResponseSchema = z.object({
  sessionId: z.string().uuid(),
  eventId: z.string().uuid(),
  source: pickSourceSchema,
  song: pickedSongSchema,
  candidateCount: z.number().int().nonnegative(),
  reason: z.string(),
  recentFilterRelaxed: z.boolean(),
  algorithmVersion: z.string(),
  skipSuggestion: z.boolean().default(false)
});
export type PickResponse = z.infer<typeof pickResponseSchema>;

export const pickContextResponseSchema = z.object({
  sessionId: z.string().uuid().nullable(),
  current: pickResponseSchema.nullable(),
  filters: pickFiltersSchema,
  avoidRecent: z.boolean(),
  ktvExhausted: z.boolean(),
  counts: z.object({
    repertoire: z.number().int().nonnegative(),
    global: z.number().int().nonnegative(),
    nextKtv: z.number().int().nonnegative()
  }),
  facets: z.object({
    languages: z.array(z.string()),
    genres: z.array(z.string())
  })
});
export type PickContextResponse = z.infer<typeof pickContextResponseSchema>;

export const createSongSchema = z.object({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().min(1).max(120),
  version: z.string().trim().max(120).optional(),
  language: z.string().trim().max(40).optional(),
  genre: z.string().trim().max(40).optional(),
  difficulty: difficultySchema.optional(),
  performanceType: performanceTypeSchema.default('solo'),
  lyrics: z.string().max(200_000).optional(),
  lyricsTranslit: z.string().max(200_000).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  collectionType: collectionTypeSchema.default('learning'),
  personalDifficulty: difficultySchema.nullable().optional(),
  note: z.string().trim().max(1000).optional(),
  memoryCue: z.string().trim().max(500).optional(),
  keyShift: z.number().int().min(-12).max(12).nullable().optional(),
  duplicateAction: z.enum(['reuse', 'submit_review', 'create_anyway']).optional(),
  matchedSongId: z.number().int().positive().optional()
});

/** 全局歌曲公共资料只能由管理员或曲库管家维护，个人评分等数据不进入此结构。 */
export const updateSongSchema = z.object({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().min(1).max(120),
  version: z.string().trim().max(120).nullable().optional(),
  language: z.string().trim().max(40).nullable().optional(),
  genre: z.string().trim().max(40).nullable().optional(),
  difficulty: difficultySchema.nullable().optional(),
  performanceType: performanceTypeSchema,
  lyrics: z.string().max(200_000).nullable().optional(),
  lyricsTranslit: z.string().max(200_000).nullable().optional()
});
export type UpdateSong = z.infer<typeof updateSongSchema>;

export const collectionUpdateSchema = z.object({ collectionType: collectionTypeSchema });
export const snoozeSchema = z.object({ until: z.iso.datetime() });
export const updateSongUserMetaSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable().optional(),
  personalDifficulty: difficultySchema.nullable().optional(),
  keyShift: z.number().int().min(-12).max(12).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  memoryCue: z.string().trim().max(500).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, { message: '至少需要修改一项个人歌曲设置。' });
export const completePickSchema = z.object({
  requestId: z.string().uuid(),
  rating: z.number().int().min(1).max(5).optional(),
  note: z.string().max(1000).optional(),
  keyShift: z.number().int().min(-12).max(12).optional()
});
export const notePickSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  note: z.string().max(1000).optional(),
  keyShift: z.number().int().min(-12).max(12).optional()
});

export const setupSchema = z.object({
  username: z.string().trim().min(2).max(40),
  password: z.string().min(8).max(200)
});
export const loginSchema = setupSchema;
export const registrationSettingSchema = z.object({ open: z.boolean() });

export const adminCreateUserSchema = setupSchema.extend({
  isMaintainer: z.boolean().default(false),
  canAddSongs: z.boolean().default(true)
});
export const adminUpdateUserSchema = z.object({
  isMaintainer: z.boolean().optional(),
  canAddSongs: z.boolean().optional()
}).refine((value) => value.isMaintainer !== undefined || value.canAddSongs !== undefined, {
  message: '至少需要修改一项用户权限。'
});
export const adminResetPasswordSchema = z.object({ password: z.string().min(8).max(200) });

export interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  isMaintainer: boolean;
  canAddSongs: boolean;
  createdAt: string;
}

export const importSchema = z.object({
  format: z.enum(['json', 'csv', 'text']),
  content: z.string().min(1).max(2_000_000),
  collectionType: collectionTypeSchema.default('learning')
});

export const createPlaylistSchema = z.object({
  name: z.string().trim().min(1).max(80),
  collaboratorUserIds: z.array(z.number().int().positive()).max(20).default([])
});
export const updatePlaylistSchema = z.object({ name: z.string().trim().min(1).max(80) });
export const reorderPlaylistSchema = z.object({ songIds: z.array(z.number().int().positive()).max(5000) });

export interface HistoryItem {
  id: string;
  songId: number;
  title: string;
  artist: string;
  version: string | null;
  status: 'played' | 'skipped';
  occurredAt: string;
  rating: number | null;
  note: string | null;
}

export interface HistorySummary {
  playedTotal: number;
  playedToday: number;
  favoriteArtist: string | null;
}

export const approveReviewSchema = updateSongSchema.extend({ reviewNote: z.string().trim().max(1000).optional() });
export const reviewDecisionSchema = z.object({ reviewNote: z.string().trim().max(1000).optional() });
