export function look({ hotspotId, state }) {
  switch (hotspotId) {
    case 'moose': return { say: 'A moose head, mounted over the wainscot. It looks like it has seen things.' };
    case 'back_door': return { say: state.flags.sliceComplete ? 'The back room door stands ajar.' : 'A door marked STAFF ONLY. Someone has added "(AND FRIENDS)" in marker.' };
    case 'restroom': return { say: 'A grey door. A hand-lettered sign: OUT OF ORDER.' };
    case 'mirror': return { say: 'A big mirror behind the bottles. You look about as good as the room does.' };
    case 'bar': return { say: 'A long bar with five stools and one bartender polishing the same glass.' };
  }
}

export function talk({ hotspotId, state }) {
  if (hotspotId !== 'bar') return look({ hotspotId, state });
  if (state.flags.sliceComplete) return { say: 'Bartender: Go on, you have a back room to see.' };
  if (state.inventory.includes('whiskey')) return { say: 'Bartender: That drink is for the back door, friend. Not for you.' };
  if (state.inventory.includes('dollar_bill')) return { say: 'Bartender: A dollar? That buys a whiskey. Slide it over (Use the bar).' };
  return { say: "Bartender: Whiskey's a dollar. Cash up front. Come back when you have one." };
}

export function use({ hotspotId, state }) {
  switch (hotspotId) {
    case 'bar': {
      if (state.inventory.includes('whiskey')) return { say: 'You already have a drink. Pace yourselves.' };
      if (state.flags.boughtDrink) return { say: 'The bartender shakes his head: one per customer, shared among friends.' };
      if (!state.inventory.includes('dollar_bill')) return { say: "The bartender raises an eyebrow. 'Cash first.'" };
      return {
        flags: { boughtDrink: true },
        inventory: { remove: ['dollar_bill'], add: ['whiskey'] },
        say: 'You slide the dollar across. A glass of whiskey slides back.',
      };
    }
    case 'restroom': return look({ hotspotId, state });
    case 'back_door': {
      if (state.flags.sliceComplete) return { say: 'Already unlocked. The rooms beyond have not been authored yet.' };
      if (!state.inventory.includes('whiskey')) return { say: "Locked. A voice behind it says: 'Password is a drink.'" };
      return {
        flags: { sliceComplete: true },
        inventory: { remove: ['whiskey'] },
        say: 'You pass the whiskey through the gap. The lock clicks. END OF THE DEMO SLICE: the rooms beyond are not authored yet.',
      };
    }
    default: return look({ hotspotId, state });
  }
}
