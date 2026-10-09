export function look({ hotspotId, state }) {
  switch (hotspotId) {
    case 'gutter': return { say: state.flags.dollarTaken ? 'Gum and grit.' : 'Something green is stuck in the gutter.' };
    case 'newspaper': return { say: 'A newspaper box. The headline is about a different city.' };
    case 'pole': return { say: 'A lamp pole carrying a suspicious amount of tape.' };
    case 'shop_door': return { say: 'A sign says BACK IN 10 MINUTES. It has said that for years.' };
    case 'shop_window': return { say: 'Shelves of things you could buy if the door ever opened.' };
    case 'chub': return { say: 'Chub & Co. A nicer storefront than anything you can afford.' };
  }
}

export function use({ hotspotId, state }) {
  if (hotspotId === 'gutter') {
    if (state.flags.dollarTaken) return { say: 'Nothing else down there.' };
    return { flags: { dollarTaken: true }, inventory: { add: ['dollar_bill'] }, say: 'You peel a damp dollar bill out of the gutter.' };
  }
  if (hotspotId === 'newspaper') return { say: "It's empty. Of course." };
  return look({ hotspotId, state });
}
