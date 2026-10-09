import { z } from 'zod';

export const CHAT_MAX = 200;
export const NAME_MAX = 16;
export const MAX_PLAYERS = 16;
export const TICK_HZ = 10;
export const CODE_RE = /^[A-Z]{4}$/;

export const FacingSchema = z.enum(['left', 'right', 'up', 'down']);
export const AnimSchema = z.enum(['idle', 'walk']);
export const VerbSchema = z.enum(['look', 'talk', 'use', 'walk']);

export type Facing = z.infer<typeof FacingSchema>;
export type Anim = z.infer<typeof AnimSchema>;
export type Verb = z.infer<typeof VerbSchema>;

export const PlayerSchema = z
  .object({
    name: z.string(),
    x: z.number(),
    y: z.number(),
    facing: FacingSchema,
    roomId: z.string(),
    anim: AnimSchema,
  })
  .strict();
export type Player = z.infer<typeof PlayerSchema>;

export const FlagValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export const FlagsSchema = z.record(FlagValueSchema);
export type Flags = z.infer<typeof FlagsSchema>;

export const ChatEntrySchema = z
  .object({ id: z.string(), name: z.string(), text: z.string(), t: z.number() })
  .strict();
export type ChatEntry = z.infer<typeof ChatEntrySchema>;

export const StateSchema = z
  .object({
    roomId: z.string(),
    players: z.record(PlayerSchema),
    flags: FlagsSchema,
    inventory: z.array(z.string()),
    chat: z.array(ChatEntrySchema),
  })
  .strict();
export type SessionState = z.infer<typeof StateSchema>;

// ---- client -> server ------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), code: z.string(), name: z.string().optional() }).strict(),
  z.object({ type: z.literal('input'), seq: z.number().int(), x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('verb'), hotspotId: z.string(), verb: VerbSchema }).strict(),
  z.object({ type: z.literal('chat'), text: z.string() }).strict(),
  z.object({ type: z.literal('pose'), anim: AnimSchema }).strict(),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- server -> client ------------------------------------------------------

export const MoveEntrySchema = z
  .object({ x: z.number(), y: z.number(), facing: FacingSchema, anim: AnimSchema, seq: z.number() })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), playerId: z.string(), state: StateSchema }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
  // Event-driven changes. players[id] = null means the player left.
  z
    .object({
      type: z.literal('patch'),
      players: z.record(PlayerSchema.nullable()).optional(),
      flags: FlagsSchema.optional(),
      inventory: z.array(z.string()).optional(),
    })
    .strict(),
  // 10 Hz authoritative positions for players that moved this tick.
  z.object({ type: z.literal('move'), t: z.number(), players: z.record(MoveEntrySchema) }).strict(),
  z
    .object({
      type: z.literal('result'),
      actorId: z.string(),
      hotspotId: z.string(),
      verb: VerbSchema,
      say: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('chat'), entry: ChatEntrySchema }).strict(),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Parse a JSON text frame; returns null on any failure (bad JSON, unknown fields, wrong types). */
export function parseWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : null;
}

// ---- room content (shared by server and client) ----------------------------

export type Pt = [number, number];
export type Rect = [number, number, number, number];

export const RoomSchema = z.object({
  id: z.string(),
  size: z.tuple([z.number(), z.number()]).default([320, 168]),
  background: z.string(),
  ambient: z.string().optional(),
  walk: z.array(z.tuple([z.number(), z.number()])),
  scale: z
    .object({ yMin: z.number(), yMax: z.number(), scaleMin: z.number(), scaleMax: z.number() })
    .default({ yMin: 0, yMax: 1, scaleMin: 1, scaleMax: 1 }),
  masks: z.array(z.object({ image: z.string() })).default([]),
  hotspots: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        verb: VerbSchema.default('look'),
        script: z.string().optional(),
        /** Where the actor stands to use/talk; defaults to the walkable point nearest the rect's bottom centre. */
        at: z.tuple([z.number(), z.number()]).optional(),
      }),
    )
    .default([]),
  exits: z
    .array(
      z.object({
        rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        to: z.string(),
        spawn: z.tuple([z.number(), z.number()]),
        requires: z.string().optional(),
      }),
    )
    .default([]),
  lights: z
    .array(z.object({ x: z.number(), y: z.number(), radius: z.number(), color: z.string() }))
    .default([]),
});
export type Room = z.infer<typeof RoomSchema>;

export const IndexSchema = z.object({
  start: z.string(),
  rooms: z.array(z.string()),
  player: z
    .object({
      view: z.string(),
      dirs: z.object({ right: z.number(), left: z.number(), down: z.number(), up: z.number() }),
      frameMs: z.number().default(130),
    })
    .optional(),
});
export type ContentIndex = z.infer<typeof IndexSchema>;

export const ViewSchema = z.object({
  viewId: z.string(),
  loops: z.array(
    z.array(z.object({ file: z.string(), w: z.number(), h: z.number(), originX: z.number(), originY: z.number() })),
  ),
});
export type ViewSidecar = z.infer<typeof ViewSchema>;

export function scaleAt(room: Pick<Room, 'scale'>, y: number): number {
  const s = room.scale;
  const span = s.yMax - s.yMin;
  const t = span === 0 ? 1 : Math.min(1, Math.max(0, (y - s.yMin) / span));
  return s.scaleMin + (s.scaleMax - s.scaleMin) * t;
}
