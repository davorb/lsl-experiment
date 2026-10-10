// Wire format for the AGI-interpreter mode (strict: unknown fields are rejected on both sides).
import { z } from 'zod';

export const AgiObjSchema = z.object({ id: z.number(), view: z.number(), loop: z.number(), cel: z.number(), x: z.number(), y: z.number(), pri: z.number() }).strict();
export type AgiObj = z.infer<typeof AgiObjSchema>;

export const AgiPicOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draw'), pic: z.number() }).strict(),
  z.object({ kind: z.literal('overlay'), pic: z.number() }).strict(),
  z.object({ kind: z.literal('add'), view: z.number(), loop: z.number(), cel: z.number(), x: z.number(), y: z.number(), pri: z.number() }).strict(),
]);
export type AgiPicOp = z.infer<typeof AgiPicOpSchema>;

export const AgiModalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('print'), text: z.string(), row: z.number().optional(), col: z.number().optional(), width: z.number().optional() }).strict(),
  z.object({ kind: z.literal('string'), prompt: z.string(), len: z.number() }).strict(),
  z.object({ kind: z.literal('number'), prompt: z.string() }).strict(),
  z.object({ kind: z.literal('inventory'), items: z.array(z.object({ id: z.number(), name: z.string() }).strict()), select: z.boolean() }).strict(),
  z.object({ kind: z.literal('showobj'), view: z.number(), name: z.string(), desc: z.string() }).strict(),
  z.object({ kind: z.literal('message'), text: z.string() }).strict(),
]);
export type AgiModal = z.infer<typeof AgiModalSchema>;

export const AgiTextSchema = z.object({ row: z.number(), col: z.number(), text: z.string(), fg: z.number(), bg: z.number() }).strict();
export const AgiMenuSchema = z
  .object({ title: z.string(), items: z.array(z.object({ text: z.string(), controller: z.number(), enabled: z.boolean() }).strict()) })
  .strict();

/** Another player's walking avatar (the shared ego is drawn from `objs`). */
export const AgiAvatarSchema = z.object({ id: z.string(), name: z.string(), x: z.number(), y: z.number(), loop: z.number(), cel: z.number() }).strict();
export type AgiAvatar = z.infer<typeof AgiAvatarSchema>;

export const AgiFrameSchema = z
  .object({
    room: z.number(),
    picVersion: z.number(),
    objs: z.array(AgiObjSchema),
    texts: z.array(AgiTextSchema),
    textMode: z.boolean(),
    statusLine: z.boolean(),
    score: z.number(),
    maxScore: z.number(),
    soundOn: z.boolean(),
    accept: z.boolean(),
    /** Player currently driving the ego (null when nobody has acted yet). */
    egoOwner: z.string().nullable(),
    avatars: z.array(AgiAvatarSchema),
    menus: z.array(AgiMenuSchema),
  })
  .strict();
export type AgiFrame = z.infer<typeof AgiFrameSchema>;
