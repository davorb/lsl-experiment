// Outside the all-night store (AGI logic 22).
const t = (c, ...n) => c.text(22, ...n) ?? '…';

export function look(c) {
  switch (c.hotspotId) {
    case 'pole': return { say: t(c, 1) };
    case 'phone': return { say: t(c, 22) };
    case 'shop_window': return { say: t(c, 66) };
    case 'shop_door': case 'store': return { say: t(c, 34) };
    case 'bum': return { say: t(c, 32) };
  }
}

export function use(c) {
  switch (c.hotspotId) {
    case 'phone': return { say: t(c, 36) };
    case 'shop_door': return { say: t(c, 67) };
    case 'bum': return { say: t(c, 49) };
    default: return look(c);
  }
}

export function talk(c) {
  if (c.hotspotId !== 'bum') return look(c);
  const choices = [{ id: 'no', label: 'No thanks.' }];
  if (Number(c.state.flags.cash ?? 0) >= 1) choices.unshift({ id: 'dollar', label: 'Give him a dollar.' });
  if (c.state.inventory.includes('whiskey')) choices.unshift({ id: 'whiskey', label: 'Give him the glass of whiskey.' });
  return { say: t(c, 23), choices };
}

export function choose(c) {
  if (c.hotspotId !== 'bum') return;
  const cash = Number(c.state.flags.cash ?? 0);
  switch (c.choice) {
    case 'whiskey':
      if (!c.state.inventory.includes('whiskey')) return { say: '' };
      return { inventory: { remove: ['whiskey'] }, say: t(c, 2) };
    case 'dollar':
      if (cash < 1) return { say: '' };
      return { flags: { cash: cash - 1 }, say: t(c, 31) };
    default: return { say: t(c, 28) };
  }
}
