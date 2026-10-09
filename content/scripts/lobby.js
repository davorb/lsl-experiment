export function look({ hotspotId, state }) {
  if (hotspotId === 'door') return { say: state.flags.doorOpen ? 'The door stands open.' : 'A heavy door. It looks locked.' };
  if (hotspotId === 'desk') return { say: 'A reception desk with a single drawer.' };
}

export function use({ state, hotspotId }) {
  if (hotspotId === 'desk') {
    if (state.flags.keyTaken) return { say: 'The drawer is empty.' };
    return { flags: { keyTaken: true }, inventory: { add: ['brass_key'] }, say: 'You find a brass key in the drawer.' };
  }
  if (hotspotId === 'door') {
    if (state.flags.doorOpen) return { say: 'Already open.' };
    if (!state.inventory.includes('brass_key')) return { say: "It's locked." };
    return {
      flags: { doorOpen: true },
      inventory: { remove: ['brass_key'] },
      say: 'The key turns and the door swings open.',
    };
  }
}
