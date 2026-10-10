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
