export function look({ hotspotId }) {
  switch (hotspotId) {
    case 'flyer': return { say: 'A flyer, taped to the pole at an optimistic angle: "OPEN MIC NIGHT. Bring your own audience."' };
    case 'door': return { say: "The red door of Lefty's. Music leaks out, along with the smell of old whiskey." };
    case 'window': return { say: 'Glass blocks. You can see light inside and nothing else.' };
    case 'hotel': return { say: 'A hotel sign, mostly lit. It buzzes like it has opinions.' };
    case 'trash': return { say: 'A trash can with the lid on crooked.' };
    case 'building': return { say: "Lefty's Bar, a gray box of a building with a doorway and big ideas." };
  }
}

export function use({ hotspotId, state }) {
  switch (hotspotId) {
    case 'door': return { say: 'You push through the red door.', go: { room: 'lsl_bar', spawn: [160, 150] } };
    case 'trash': return { say: state.flags.dollarTaken ? 'Nothing in there worth a second look.' : 'You find a half-eaten sandwich. You put it back.' };
    default: return look({ hotspotId });
  }
}
