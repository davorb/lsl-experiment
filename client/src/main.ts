import { Game } from './game';
import { AgiGame } from './agi/game';
import { Synth } from './agi/sound';
import { Lobby } from './lobby';
import { Net } from './net';
import { parseWith, type ClientMessage } from '../../shared/protocol';

void parseWith;
const net = new Net();
const synth = new Synth();

const lobby: Lobby = new Lobby(async (name) => {
  synth.unlock(); // the join click is the user gesture browsers require for audio
  try {
    await net.connect();
  } catch (e) {
    lobby.showError(e instanceof Error ? e.message : 'Connection failed.');
    return;
  }
  net.onClose = () => lobby.showError('Disconnected from server.');
  // The first reply tells us which engine this room runs.
  net.onMessage = (m) => {
    if (m.type === 'error') { lobby.showError(m.message); return; }
    if (m.type === 'agi_welcome') {
      lobby.destroy();
      void new AgiGame(net, synth, m.playerId, m.chat).start();
    } else if (m.type === 'welcome') {
      lobby.destroy();
      new Game(net).begin(m);
    }
  };
  const hello: ClientMessage = { type: 'hello', name: name || undefined };
  net.send(hello);
});
