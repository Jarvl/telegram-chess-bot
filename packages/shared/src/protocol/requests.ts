import { z } from 'zod';
import { GroupSettingsSchema, PrefsSchema, UciSchema } from './dto';
import { ColourChoiceSchema, EngineLevelSchema, TimePerMoveSchema } from './enums';
import { UserIdSchema } from './ids';

export const LaunchRequestSchema = z.object({
  initData: z.string().min(1).max(4096),
});

export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

export const MoveRequestSchema = z.object({
  uci: UciSchema,
  expectedPly: z.number().int().min(0),
  /** Client-generated id reused on retries so a move is applied at most once (spec §7.4). */
  clientMoveId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

export type MoveRequest = z.infer<typeof MoveRequestSchema>;

export const ChallengeRequestSchema = z.object({
  /** null for an open challenge. */
  opponentId: UserIdSchema.nullable(),
  timePerMove: TimePerMoveSchema,
  colour: ColourChoiceSchema,
  rated: z.boolean(),
});

export type ChallengeRequest = z.infer<typeof ChallengeRequestSchema>;

/** Starts a game against the bot. No `rated` field: the domain layer forces it false (spec §6.1). */
export const EngineGameRequestSchema = z.object({
  level: EngineLevelSchema,
  colour: ColourChoiceSchema,
  timePerMove: TimePerMoveSchema,
});

export type EngineGameRequest = z.infer<typeof EngineGameRequestSchema>;

export const ShareRequestSchema = z.object({
  ply: z.number().int().min(0),
});

export type ShareRequest = z.infer<typeof ShareRequestSchema>;

export const PrefsUpdateRequestSchema = z.object({
  prefs: PrefsSchema.partial().optional(),
  writeAccess: z.object({ allowed: z.boolean() }).optional(),
});

export type PrefsUpdateRequest = z.infer<typeof PrefsUpdateRequestSchema>;

export const GroupSettingsUpdateRequestSchema = GroupSettingsSchema.partial();

export type GroupSettingsUpdateRequest = z.infer<typeof GroupSettingsUpdateRequestSchema>;

export const BlockRequestSchema = z.object({
  userId: UserIdSchema,
});

export type BlockRequest = z.infer<typeof BlockRequestSchema>;

export const TelemetryRequestSchema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(['launch_failed', 'move_retry', 'sse_failed']),
        code: z.string().max(64).optional(),
        durationMs: z.number().int().min(0).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export type TelemetryRequest = z.infer<typeof TelemetryRequestSchema>;

export const FinishedQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
});

export type FinishedQuery = z.infer<typeof FinishedQuerySchema>;
