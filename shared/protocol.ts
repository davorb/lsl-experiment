import { z } from 'zod';
import { AgiAvatarSchema, AgiFrameSchema, AgiModalSchema } from './agi/protocol';

export const CHAT_MAX = 200;
export const NAME_MAX = 16;
export const MAX_PLAYERS = 16;
export const TICK_HZ = 10;
export const CODE_RE = /^[A-Z]{4}$/;

export const FacingSchema = z.enum(['left', 'right', 'up', 'down']);
export const AnimSchema = z.enum(['idle', 'walk', 'sit']);
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
  z.object({ type: z.literal('hello'), code: z.string().optional(), name: z.string().optional() }).strict(),
  z.object({ type: z.literal('input'), seq: z.number().int(), x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('verb'), hotspotId: z.string(), verb: VerbSchema }).strict(),
  z.object({ type: z.literal('chat'), text: z.string() }).strict(),
  z.object({ type: z.literal('pose'), anim: AnimSchema }).strict(),
  z.object({ type: z.literal('choice'), hotspotId: z.string(), choice: z.string() }).strict(),
  // AGI mode
  z.object({ type: z.literal('agi_cmd'), text: z.string() }).strict(),
  z.object({ type: z.literal('agi_dir'), dir: z.number().int().min(0).max(8) }).strict(),
  z.object({ type: z.literal('agi_goto'), x: z.number(), y: z.number() }).strict(),
  z.object({ type: z.literal('agi_key'), ascii: z.number().int(), scan: z.number().int() }).strict(),
  z.object({ type: z.literal('agi_ack'), mid: z.number().int(), value: z.union([z.string(), z.number()]).optional() }).strict(),
  z.object({ type: z.literal('agi_menu'), controller: z.number().int() }).strict(),
]);
void AgiAvatarSchema;
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
      /** Only sent to the acting player; they answer with a `choice` message. */
      choices: z.array(z.object({ id: z.string(), label: z.string() }).strict()).optional(),
    })
    .strict(),
  z.object({ type: z.literal('chat'), entry: ChatEntrySchema }).strict(),
  // AGI mode
  z.object({ type: z.literal('agi_welcome'), playerId: z.string(), chat: z.array(ChatEntrySchema) }).strict(),
  z.object({ type: z.literal('agi_frame'), frame: AgiFrameSchema }).strict(),
  z.object({ type: z.literal('agi_pic'), version: z.number(), visual: z.string(), priority: z.string() }).strict(),
  z.object({ type: z.literal('agi_modal'), mid: z.number(), modal: AgiModalSchema, owner: z.string().nullable() }).strict(),
  z.object({ type: z.literal('agi_modal_close'), mid: z.number() }).strict(),
  z.object({ type: z.literal('agi_sound'), n: z.number().nullable() }).strict(),
  z.object({ type: z.literal('agi_players'), players: z.record(z.string()) }).strict(),
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
  /** AGI priority map (red channel = priority * 16). Pixels with priority above an actor's draw over it. */
  priority: z.string().optional(),
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
  /** Non-interactive scenery and NPC sprites taken from extracted views. */
  props: z
    .array(
      z.object({
        view: z.string(),
        loop: z.number().default(0),
        cel: z.number().default(0),
        /** Original AGI placement: bottom-left in 160-wide units. Converted to native foot-centre on load. */
        agi: z.tuple([z.number(), z.number()]).optional(),
        /** Native foot-centre, when not using `agi`. */
        at: z.tuple([z.number(), z.number()]).optional(),
        /** Cycle through the loop's cels at this interval; omit for a still frame. */
        cycleMs: z.number().optional(),
      }),
    )
    .default([]),
});
export type Room = z.infer<typeof RoomSchema>;

export const IndexSchema = z.object({
  start: z.string(),
  rooms: z.array(z.string()),
  startFlags: FlagsSchema.optional(),
  startInventory: z.array(z.string()).optional(),
  player: z
    .object({
      view: z.string(),
      dirs: z.object({ right: z.number(), left: z.number(), down: z.number(), up: z.number() }),
      frameMs: z.number().default(130),
      /** Sprite used while the `sit` pose is active. */
      sit: z.object({ view: z.string(), loop: z.number(), cel: z.number() }).optional(),
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

/** AGI actor priority from foot Y: bands of 12px starting at y=48 (priority 5), capped at 14. */
export function actorPriority(y: number): number {
  return y < 48 ? 4 : Math.min(14, Math.floor((y - 48) / 12) + 5);
}
/** First foot Y at which an actor reaches priority `q`. */
export function priorityStartY(q: number): number {
  return q <= 4 ? 0 : 48 + (q - 5) * 12;
}
