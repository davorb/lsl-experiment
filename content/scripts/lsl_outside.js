// Outside Lefty's (AGI logic 11). Dialogue is pulled from the extracted game text by message number.
const t = (c, ...n) => c.text(11, ...n) ?? '…';

export function look(c) {
  switch (c.hotspotId) {
    case 'neon': return { say: t(c, 1) };
    case 'pole_sign': return { say: t(c, 2) };
    case 'window': case 'window2': return { say: t(c, 6) };
    case 'door': return { say: t(c, 8) };
    case 'doormat': return { say: t(c, 9) };
    case 'building': return { say: t(c, 4) };
  }
}

export function use(c) {
  switch (c.hotspotId) {
    case 'door': return { go: { room: 'lsl_bar', spawn: [160, 150] } };
    case 'doormat': return { say: t(c, 10, 11, 12) };
    case 'window': case 'window2': return { say: t(c, 7) };
    default: return look(c);
  }
}
