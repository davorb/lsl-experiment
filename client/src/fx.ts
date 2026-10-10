import { Color, Container, Filter, GlProgram, Graphics, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import type { Room } from '../../shared/protocol';

function radialCanvas(size: number, inner: number, outerAlpha: number, innerAlpha: number, rgb = '255,255,255'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, size * inner, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb},${innerAlpha})`);
  grad.addColorStop(1, `rgba(${rgb},${outerAlpha})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

let lightTex: Texture | null = null;
function lightTexture(): Texture {
  return (lightTex ??= Texture.from(radialCanvas(128, 0, 0, 1)));
}

let vignetteTex: Texture | null = null;
export function vignetteTexture(): Texture {
  return (vignetteTex ??= Texture.from(radialCanvas(256, 0.45, 1, 0, '0,0,0')));
}

export interface LightLayers {
  /** Multiplies the world: ambient colour plus additive light pools. */
  multiply: Sprite;
  /** Soft additive glow drawn on top (cheap bloom for the lights only). */
  glow: Container;
  dispose(): void;
}

export function buildLights(renderer: Renderer, room: Pick<Room, 'size' | 'ambient' | 'lights'>): LightLayers {
  const [w, h] = room.size;
  const rt = RenderTexture.create({ width: w, height: h, resolution: 1, scaleMode: 'linear' });
  const scene = new Container();
  const ambient = room.ambient ?? '#a89a92';
  scene.addChild(new Graphics().rect(0, 0, w, h).fill(new Color(ambient).toNumber()));
  const glow = new Container();
  for (const l of room.lights) {
    const col = new Color(l.color);
    const pool = new Sprite(lightTexture());
    pool.anchor.set(0.5);
    pool.position.set(l.x, l.y);
    pool.width = pool.height = l.radius * 2;
    pool.tint = col.toNumber();
    pool.alpha = col.alpha;
    pool.blendMode = 'add';
    scene.addChild(pool);

    const g = new Sprite(lightTexture());
    g.anchor.set(0.5);
    g.position.set(l.x, l.y);
    g.width = g.height = l.radius * 1.2;
    g.tint = col.toNumber();
    g.alpha = Math.min(1, col.alpha * 0.7);
    g.blendMode = 'add';
    glow.addChild(g);
  }
  renderer.render({ container: scene, target: rt, clear: true });
  scene.destroy({ children: true });
  const multiply = new Sprite(rt);
  multiply.blendMode = 'multiply';
  return { multiply, glow, dispose: () => { multiply.destroy(); rt.destroy(true); glow.destroy({ children: true }); } };
}

const VERT = `
precision highp float;
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`;

// Variable-radius disc blur: radius ramps up toward the top and bottom of the frame, zero in the middle band.
const FRAG = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform float uBlur;
uniform vec2 uBands;
void main(void) {
  float y = vTextureCoord.y;
  float amt = max(1.0 - smoothstep(0.0, uBands.x, y), smoothstep(1.0 - uBands.y, 1.0, y));
  vec4 sum = texture(uTexture, vTextureCoord);
  float n = 1.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / 16.0);
    vec2 o = vec2(cos(a), sin(a)) * r * amt * uBlur * uInputSize.zw;
    sum += texture(uTexture, vTextureCoord + o);
    n += 1.0;
  }
  finalColor = sum / n;
}`;

export interface TiltShift { filter: Filter; setBlurTexels(px: number): void }

export function makeTiltShift(topBand = 0.18, bottomBand = 0.22): TiltShift {
  const filter = new Filter({
    glProgram: GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'tilt-shift' }),
    resources: {
      tiltUniforms: {
        uBlur: { value: 4, type: 'f32' },
        uBands: { value: new Float32Array([topBand, bottomBand]), type: 'vec2<f32>' },
      },
    },
  });
  return {
    filter,
    setBlurTexels(px: number) {
      (filter.resources['tiltUniforms'] as { uniforms: { uBlur: number } }).uniforms.uBlur = px;
    },
  };
}

// ---- 2.5D depth effects -----------------------------------------------------------------------

let dotTex: Texture | null = null;
/** Soft white dot for dust motes. */
export function dotTexture(): Texture {
  return (dotTex ??= Texture.from(radialCanvas(32, 0, 0, 1)));
}

let shadowTex: Texture | null = null;
/** Soft black blob used (squashed) as a ground shadow. */
export function shadowTexture(): Texture {
  return (shadowTex ??= Texture.from(radialCanvas(64, 0.1, 0, 1, '0,0,0')));
}

let shaftTex: Texture | null = null;
/** Vertical beam: bright at the top, fading down and soft at the sides. */
export function shaftTexture(): Texture {
  if (shaftTex) return shaftTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 128);
  v.addColorStop(0, 'rgba(255,255,255,0.9)');
  v.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 128);
  return (shaftTex = Texture.from(c));
}

/**
 * Depth map from the AGI priority screen. Depth is 0 (far) to 1 (near): mostly the row (AGI priority bands
 * rise with y), pushed nearer wherever a high-priority foreground object sits above its row. Lightly blurred
 * so the parallax doesn't tear at hard edges.
 */
export function depthTexture(priority: Uint8Array, w: number, h: number, bandStartY: (q: number) => number): Texture {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = priority[y * w + x]!;
      d[y * w + x] = Math.max(y / (h - 1), q > 4 && q <= 15 ? bandStartY(q) / h : 0);
    }
  }
  const out = new ImageData(w * 2, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += d[yy * w + xx]!; n++;
      }
      const v = Math.round(255 * Math.min(1, s / n));
      for (let k = 0; k < 2; k++) {
        const o = (y * w * 2 + x * 2 + k) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
        out.data[o + 3] = 255;
      }
    }
  }
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = h;
  c.getContext('2d')!.putImageData(out, 0, 0);
  const t = Texture.from(c);
  t.source.scaleMode = 'linear';
  return t;
}

const DEPTH_FRAG = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uDepth;
uniform vec4 uInputSize;
uniform float uBlur;
uniform float uFocus;
uniform vec2 uParallax;
uniform vec4 uFog;
uniform float uKey;
void main(void) {
  vec2 uv = vTextureCoord;
  // Mild keystone: rows get wider toward the bottom, as if the picture lay back like a stage floor.
  uv.x = 0.5 + (uv.x - 0.5) / (1.0 + uKey * uv.y);
  // Parallax by depth: far layers slide one way, near the other, pivoting on mid-depth. Refined once so
  // the depth is read where the pixel really comes from.
  vec2 p = uv - uParallax * (texture(uDepth, uv).r - 0.5);
  p = uv - uParallax * (texture(uDepth, p).r - 0.5);
  p = clamp(p, vec2(0.0), vec2(1.0));
  float d = texture(uDepth, p).r;
  // Depth of field: sharp at the player's depth, softer the further away.
  float amt = 0.75 * smoothstep(0.28, 0.85, abs(d - uFocus));
  vec4 sum = texture(uTexture, p);
  float n = 1.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / 16.0);
    vec2 o = vec2(cos(a), sin(a)) * r * amt * uBlur * uInputSize.zw;
    sum += texture(uTexture, p + o);
    n += 1.0;
  }
  vec3 col = sum.rgb / n;
  // Aerial perspective: distance washes toward the fog colour.
  col = mix(col, uFog.rgb, uFog.a * pow(1.0 - d, 3.0));
  finalColor = vec4(col, 1.0);
}`;

export interface DepthFx {
  filter: Filter;
  setBlurTexels(px: number): void;
  setDepth(t: Texture): void;
  setFocus(depth: number): void;
  /** Camera offset in uv units (x, y). */
  setParallax(x: number, y: number): void;
  setFog(rgb: [number, number, number], amount: number): void;
  setKeystone(keystone: number): void;
}

export function makeDepthFx(): DepthFx {
  const blank = Texture.from(Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
  const filter = new Filter({
    glProgram: GlProgram.from({ vertex: VERT, fragment: DEPTH_FRAG, name: 'depth-fx' }),
    resources: {
      uDepth: blank.source,
      depthUniforms: {
        uBlur: { value: 4, type: 'f32' },
        uFocus: { value: 0.6, type: 'f32' },
        uParallax: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
        uFog: { value: new Float32Array([0.7, 0.75, 0.85, 0.2]), type: 'vec4<f32>' },
        uKey: { value: 0.035, type: 'f32' },
      },
    },
  });
  const u = () => (filter.resources['depthUniforms'] as { uniforms: Record<string, number | Float32Array> }).uniforms;
  return {
    filter,
    setBlurTexels: (px) => { u()['uBlur'] = px; },
    setDepth: (t) => { filter.resources['uDepth'] = t.source; },
    setFocus: (d) => { u()['uFocus'] = d; },
    setParallax: (x, y) => { const p = u()['uParallax'] as Float32Array; p[0] = x; p[1] = y; },
    setFog: (rgb, amount) => { const f = u()['uFog'] as Float32Array; f[0] = rgb[0]; f[1] = rgb[1]; f[2] = rgb[2]; f[3] = amount; },
    setKeystone: (keystone) => { u()['uKey'] = keystone; },
  };
}
