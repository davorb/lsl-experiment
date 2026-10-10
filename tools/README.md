# tools

## Extraction

```bash
npm run extract                       # reads ./game-data
npm run extract -- --game-data /path  # elsewhere
npm run extract -- --start pic08      # also make pic08 the start room in content/index.json
```

Detection order:

1. **AGI (Leisure Suit Larry 1)**: `PICDIR`, `VIEWDIR`, `LOGDIR` and `VOL.0` present. No external tool exists for
   this on PATH, so `tools/src/agi.ts` is a small built-in reader for pictures and views only (no logic, no sound).
   - Pictures are rendered from the vector data to `content/backgrounds/picNN.png`, 320x168. AGI pixels are 2:1, so
     each is doubled horizontally; art is otherwise native, not scaled. Pen/splatter brushes are approximated.
   - Views become `content/sprites/<view>/<loop>_<cel>.png` plus `view.json` (per-cel size and foot origin = bottom
     centre). Mirrored loops are baked. The first view with 4+ loops (view 0, Larry) is written to
     `content/index.json` as `player`, with AGI loop order right/left/down/up.
   - A stub `content/rooms/picNN.json` is written for each picture (empty walk polygon, hotspots, exits). Existing room
     files are never overwritten.
2. **Packed SCI (LSL6)**: `RESOURCE.000` / `RESMAP.000` present. No stable SCI32 extraction CLI is known to this
   project. Set `SCI_EXTRACT_CMD` to a command that accepts `<game-data> <out-dir>` and writes PNGs; the output is then
   imported as in (3):
   `SCI_EXTRACT_CMD="my-sci-export" npm run extract`
   Without it the tool fails with a one-line install hint.
3. **Pre-extracted PNGs**: PNGs anywhere under `game-data/`. Files under `backgrounds/` (or any PNG 256px+ wide) become
   backgrounds; `sprites/<view>/<cel>.png` are copied as is. Sidecar `view.json` files are not synthesized.

## What the AGI extraction writes

`content/agi/{logic,pic,view,snd}/<n>.bin` raw resources and `words.bin` / `object.bin` (the interpreter runs from
these), `content/sprites/<view>/` PNG cels the client draws, plus `content/text/` message tables. All gitignored.

## Reading the original's logic

`npx tsx tools/src/dump-logic.ts 15` prints a readable disassembly of AGI logic 15 (the bar): `said()` patterns
resolved through `WORDS.TOK`, `print()` calls with their message text, and `set.view` / `position` object setup
(AGI coordinates are x*2 in native pixels, y as is, origin bottom-left). `--check` verifies every logic parses to
exactly its message section. This is how rooms are mapped: the room number is the logic number, `set.view` tells
you which view an object uses, and the nearby `if (said(...))` / `posn(...)` tests tell you which message belongs to
which object and verb. It is a read-only authoring aid; nothing is executed.

Extraction also writes `content/text/logic<N>.json` (message tables), `views.json` (view descriptions, which
hold the inventory item "look" texts at view 100 + item number) and `objects.json` (item names).

## Authoring a room

Extraction only gives you pictures. Edit `content/rooms/<id>.json` for walk polygon, scale, hotspots, exits, lights
and add `content/scripts/<id>.js`. Click the playfield: the browser console logs native coordinates. Walk-behind masks
are white-on-black PNGs referenced from `masks`.
