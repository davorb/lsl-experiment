// HD-2D lighting per AGI room number: an ambient multiply colour plus warm/cool light pools.
// Positions are native pixels (320x168). Rooms without an entry get a neutral, slightly dimmed look.
export interface RoomLighting {
  ambient: string;
  lights: { x: number; y: number; radius: number; color: string }[];
}

const NEUTRAL: RoomLighting = { ambient: '#d6cec6', lights: [] };

const TABLE: Record<number, RoomLighting> = {
  // Outside Lefty's, night street
  11: {
    ambient: '#7c88b8',
    lights: [
      { x: 50, y: 66, radius: 75, color: 'rgba(255,205,140,0.45)' },
      { x: 137, y: 112, radius: 55, color: 'rgba(255,160,110,0.4)' },
      { x: 276, y: 40, radius: 55, color: 'rgba(120,150,255,0.35)' },
    ],
  },
  // Lefty's bar
  15: {
    ambient: '#b79a8c',
    lights: [
      { x: 160, y: 62, radius: 120, color: 'rgba(255,200,130,0.45)' },
      { x: 290, y: 100, radius: 50, color: 'rgba(255,230,190,0.3)' },
      { x: 90, y: 90, radius: 50, color: 'rgba(255,180,120,0.3)' },
    ],
  },
  // All-night store street
  22: {
    ambient: '#7b86b3',
    lights: [
      { x: 150, y: 80, radius: 80, color: 'rgba(255,235,170,0.4)' },
      { x: 300, y: 85, radius: 70, color: 'rgba(255,120,220,0.3)' },
    ],
  },
};

export function lightingFor(room: number): RoomLighting {
  return TABLE[room] ?? NEUTRAL;
}
