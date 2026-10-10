# Larry Co-op

Private co-op point-and-click for 2-16 friends, HD-2D look (PixiJS), authoritative Node server. Personal use only;
game art is never committed (`game-data/` and generated art are gitignored).

```bash
npm install
npm run extract   # once, if ./game-data contains your LSL1 (AGI) install; see tools/README.md
npm run dev       # server :8787, client :5173 (LAN-reachable)
```

Open `http://<host>:5173`, press **New room**, and send friends the URL (`/#CODE`). Without game data the app boots
into two placeholder rooms (lobby, hall). `LSL_START=pic08 npm run dev` starts in an extracted room.

`npm start` builds the client and serves everything from the Node server on `PORT` (default 8787).

## What is playable

A three-room slice of LSL1 (run `npm run extract` first; without game data the rooms fall back to placeholder art):
`lsl_street` <-> `lsl_outside` -> `lsl_bar`, with the original's characters and props placed where the original
logic places them: Lefty, the customers (the blonde, the bore on the next stool), the juke box, the ceiling fan, the
neon signs, the naugahyde door, and the bum outside the store.

- **Sit** on the empty stool, **talk** to Lefty and order (whiskey is $3 and is carried as a shared item), tip the
  juke box, talk to the bum (give him a dollar or the whiskey), or **knock** on the naugahyde door and answer the
  peephole. Giving the right password ends the slice.
- Cash, inventory and flags are shared by the whole session; positions, rooms and sitting are per player.
- Click an inventory item to look at it.

**Game text**: all dialogue and descriptions are the original's, read at run time from `content/text/` (written by
`npm run extract` from your own `game-data/`, gitignored like the art). Scripts reference lines by AGI message
number (`ctx.text(15, 21)`), so no game text is committed. Choice labels, the slice-end note and the cash amount are
the only invented strings. The rest of the game's rooms are extracted as backgrounds only.

Engine pieces behind it: hotspots walk the actor to them first (`at`); script results can carry `choices`,
`pose` (sit/stand), `go` (change room) and `inventory`/`flags` changes; rooms can declare `props` (animated or still
view cels placed with the original AGI coordinates) and a `priority` map from the picture, so a pole or a bar counter
draws over actors that are further back (priority is derived from foot Y, like AGI).

## Layout

- `shared/protocol.ts` zod schemas for every message plus room/index formats (strict: unknown fields are rejected)
- `server/` Node + `ws`: sessions by 4-letter code, 10 Hz ticks, A* on a 4px grid, scripts from `content/scripts/*.js`
- `client/` Vite + PixiJS v8: integer zoom, nearest scaling, y-sort, masks, lights, tilt-shift, vignette, DOM UI
- `tools/` extractor
- `content/` `index.json`, `rooms/*.json`, `scripts/*.js`; generated `backgrounds/ sprites/ masks/` are ignored

## Notes

- Scripts: hotspot `script: "lobby.door"` loads `content/scripts/lobby.js` and calls the export named after the verb
  (`use`, `look`, ...) with `{ state, actorId, hotspotId }`. Return `{ say, flags, inventory: { add, remove } }`.
- Exits may carry `requires: "<flag>"`; a clicked exit walks there first and leaves on arrival.
- A room with an empty `walk` polygon (fresh extraction stub) is walkable everywhere.
