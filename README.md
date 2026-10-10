# Larry Co-op

Everyone who opens the page plays the same running copy of *Leisure Suit Larry in the Land of the Lounge Lizards*
(AGI version), together, in the browser. The original game logic runs on a Node server; clients get an HD-2D
rendering (PixiJS), the original menus and status line, and the original PCjr music through WebAudio.
Personal use only: game data is never committed (`game-data/` and everything generated from it are gitignored).

```bash
npm install
npm run extract   # once: reads ./game-data (your LSL1 install) and writes the gitignored content/ files
npm run dev       # server :8787, client :5173 (LAN-reachable)
```

Open `http://<host>:5173`, enter a name, join. There are no room codes: it is one global game, and it
**restarts every two hours** (players get a chat warning five minutes before). A game with nobody in it for ten
minutes is discarded too. `npm start` builds the client and serves everything from the Node server (`PORT`, default 8787).

## How it plays

- It is the real game: type commands in the command line (`look`, `open door`, `talk to bartender`) or use the
  quick buttons; the original's menus (Sierra, File, Action, Special, Speed) are along the top. Dialogs block the
  game until someone clicks or presses Enter; typed answers (age check, prompts) come from whoever is Larry.
- The game starts the original way: title screen, then the age check and its five trivia questions. Answer the
  questions by **pressing a, b, c or d** (the game reads the key). Fail twice and it restarts, as in the original.
- **Click** the picture, or use the **arrow keys**, to walk. Clicking uses pathfinding over the picture's
  barrier data, so Larry walks around obstacles.
- Co-op: the game has one Larry. The first player to join is Larry; everyone else walks their own character around
  the same room. **Typing a command takes over Larry** (he swaps places with you), so the role is passed around
  naturally. When Larry leaves a room everyone arrives together. Chat is below the picture (chat bubbles over heads).
- Cash, inventory, score and every other piece of game state are shared by everybody.
- Music and sound effects are the original's, synthesized in the browser; the ♪ button mutes.

## Layout

- `server/src/agi/` the AGI interpreter: bytecode VM (`interp.ts`), objects/collision/animation, the text
  parser, pathfinding, and the per-game session (`session.ts`: modal dialogs, ego hand-over, avatars)
- `shared/` wire protocol (zod, strict) and the AGI format parsers (pictures, views, logic, sound) used by the
  extractor, server and client
- `client/` Vite + PixiJS v8: scene (priority-layer depth sorting, HD-2D lights, tilt-shift, vignette), DOM UI, sound
- `tools/` the extractor and `dump-logic` (a read-only disassembler used to understand the game)
- `content/` generated and gitignored, except the small placeholder files (see below)

## Dev switches (environment variables for the server)

- `LSL_SKIP_INTRO=1` start past the title and age quiz (uses the game's own restart path); `LSL_DEV=1` enables `/room N` in chat to jump to a room
- `LSL_RESET_MS=60000` change the reset interval; `LSL_MODE=legacy` run the older hand-authored placeholder engine

## Tests

`npm test` runs a smoke test of the interpreter (boot, walking, parser, pathfinding, the bar scenario, every room,
every sound). It needs the extracted game and skips itself otherwise.

## Legacy placeholder engine

Without extracted data (`content/agi/`), or with `LSL_MODE=legacy`, the server falls back to the earlier
hand-authored engine (two placeholder rooms, scripts in `content/scripts/`) so the app still boots with zero game
data. See `tools/README.md` for the extractor and for how the AGI logic was read.
