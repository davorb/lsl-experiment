export function look({ state }) {
  return { say: state.flags.lampLit ? 'The lamp glows softly.' : 'A dusty lamp.' };
}

export function use({ state }) {
  const lit = !state.flags.lampLit;
  return { flags: { lampLit: lit }, say: lit ? 'You switch the lamp on.' : 'You switch the lamp off.' };
}
