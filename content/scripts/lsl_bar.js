// Inside Lefty's (AGI logic 15): Lefty, the customers, the juke box and the naugahyde door.
const t = (c, ...n) => c.text(15, ...n) ?? '…';
const sitting = (c) => c.state.players[c.actorId]?.anim === 'sit';
const PRICE = 3;

export function look(c) {
  switch (c.hotspotId) {
    case 'lefty': return { say: t(c, 82, 83) };
    case 'blonde': return { say: t(c, 48) };
    case 'bore': case 'customers': return { say: t(c, 53) };
    case 'jukebox': return { say: t(c, 64) };
    case 'moose': return { say: t(c, 45) };
    case 'fan': return { say: t(c, 49, 50) };
    case 'art': return { say: t(c, 51) };
    case 'door': return { say: t(c, 65) };
    case 'bar': case 'stool': return { say: t(c, 1) };
  }
}

export function talk(c) {
  switch (c.hotspotId) {
    case 'lefty': {
      if (!sitting(c)) return { say: t(c, 33) };
      return {
        say: t(c, 21),
        choices: [
          { id: 'whiskey', label: c.text(15, 22) ?? 'Whiskey' },
          { id: 'beer', label: c.text(15, 23) ?? 'Beer' },
          { id: 'wine', label: c.text(15, 36) ?? 'Wine' },
          { id: 'nothing', label: 'Never mind.' },
        ],
      };
    }
    case 'blonde': return { say: t(c, 60, 56, 57) };
    case 'bore': return { say: sitting(c) ? t(c, 43) : t(c, 44) };
    case 'customers': return { say: t(c, 61) };
    case 'door': return knock(c);
    default: return look(c);
  }
}

export function use(c) {
  switch (c.hotspotId) {
    case 'lefty': return talk(c);
    case 'blonde': return { say: t(c, 67) };
    case 'jukebox': {
      const cash = Number(c.state.flags.cash ?? 0);
      if (cash < 1) return { say: t(c, 76) };
      return { flags: { cash: cash - 1 }, say: t(c, 4) };
    }
    case 'stool':
      return sitting(c)
        ? { pose: { anim: 'idle', x: 189, y: 134, facing: 'down' }, say: '' }
        : { pose: { anim: 'sit', x: 189, y: 128, facing: 'up' }, say: '' };
    case 'door': return knock(c);
    default: return look(c);
  }
}

function knock(c) {
  if (c.state.flags.sliceComplete) return { say: t(c, 9) };
  return {
    say: t(c, 5, 7),
    choices: [
      { id: 'al', label: 'Al sent me.' },
      { id: 'larry', label: "Open up, it's Larry." },
      { id: 'lefty', label: 'Lefty sent me.' },
    ],
  };
}

export function choose(c) {
  const cash = Number(c.state.flags.cash ?? 0);
  if (c.hotspotId === 'door') {
    if (c.choice !== 'al') return { say: t(c, 8) };
    return {
      flags: { sliceComplete: true },
      say: `${t(c, 9)}\n\n(End of the authored slice: the rooms beyond this door are not set up yet.)`,
    };
  }
  if (c.hotspotId !== 'lefty') return;
  const orders = { whiskey: [22], beer: [23], wine: [36, 37] };
  const order = orders[c.choice];
  if (!order) return { say: '' };
  if (!sitting(c)) return { say: t(c, 20) };
  if (cash < PRICE) return { say: t(c, ...order, 24, 26, 27) };
  const drinks = Number(c.state.flags.drinks ?? 0);
  const woozy = drinks === 0 ? 31 : 32;
  const paid = { cash: cash - PRICE, drinks: drinks + 1 };
  if (c.choice === 'whiskey') {
    // One open glass at a time: a second round gets tossed back on the spot.
    if (c.state.inventory.includes('whiskey')) return { flags: paid, say: t(c, ...order, 24, 25, 35, woozy) };
    return { flags: paid, inventory: { add: ['whiskey'] }, say: t(c, ...order, 24, 25, 38) };
  }
  if (c.choice === 'beer') return { flags: paid, say: t(c, ...order, 24, 25, 28, woozy) };
  return { flags: paid, say: t(c, ...order, 24, 25, 29, 30, woozy) };
}
