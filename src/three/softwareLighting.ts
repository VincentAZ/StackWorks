import * as THREE from 'three';

export type SurfaceMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | THREE.LineBasicMaterial;

export function pixel(r: number, g: number, b: number) {
  return (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
}

// The same ACES fitted curve and color transforms used by the exhibit's OutputPass.
function fit(v: number) {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

function srgb(v: number) {
  v = Math.max(0, Math.min(1, v));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}

export function outputPixel(r: number, g: number, b: number, toneMapped = true) {
  if (!toneMapped) return pixel(srgb(r), srgb(g), srgb(b));
  const x = fit((0.59719 * r + 0.35458 * g + 0.04823 * b) / 0.6);
  const y = fit((0.076 * r + 0.90834 * g + 0.01566 * b) / 0.6);
  const z = fit((0.02840 * r + 0.13383 * g + 0.83777 * b) / 0.6);
  return pixel(srgb(1.60475 * x - 0.53108 * y - 0.07367 * z),
    srgb(-0.10208 * x + 1.10813 * y - 0.00605 * z), srgb(-0.00327 * x - 0.07276 * y + 1.07602 * z));
}

// Blend glass and pipe layers in linear light, as the GPU does before its
// output pass. The tables keep transfer functions out of the pixel loop.
const linear = Float32Array.from({ length: 256 }, (_, i) => THREE.ColorManagement.toWorkingColorSpace(
  new THREE.Color(i / 255, i / 255, i / 255), THREE.SRGBColorSpace).r * 4095);
const encoded = Uint8Array.from({ length: 4096 }, (_, i) => srgb(i / 4095));

export function blendPixel(back: number, front: number, alpha: number) {
  const beta = 1 - alpha;
  const r = linear[back & 255] * beta + linear[front & 255] * alpha;
  const g = linear[(back >>> 8) & 255] * beta + linear[(front >>> 8) & 255] * alpha;
  const b = linear[(back >>> 16) & 255] * beta + linear[(front >>> 16) & 255] * alpha;
  return pixel(encoded[Math.round(r)], encoded[Math.round(g)], encoded[Math.round(b)]);
}

const blendTables = new Map<number, Uint8Array>();

export function blendTable(alpha: number) {
  const level = Math.round(alpha * 64);
  let table = blendTables.get(level);
  if (!table) {
    table = new Uint8Array(256 * 256);
    for (let back = 0; back < 256; back++) {
      const base = linear[back] * (1 - level / 64);
      for (let front = 0; front < 256; front++) {
        table[back * 256 + front] = encoded[Math.round(base + linear[front] * level / 64)];
      }
    }
    blendTables.set(level, table);
  }
  return table;
}

export function composite(back: number, front: number, table: Uint8Array) {
  return pixel(table[((back & 255) << 8) | (front & 255)],
    table[(back & 0xff00) | ((front >>> 8) & 255)], table[((back >>> 8) & 0xff00) | ((front >>> 16) & 255)]);
}

const STEPS = 64;
const ramps = new WeakMap<THREE.MeshStandardMaterial, { signature: string; pixels: Uint32Array }>();

// Build the material response once. The inner loop indexes diffuse irradiance and
// specular reflection separately so brass keeps its tint and paint catches white light.
function materialRamp(m: THREE.MeshStandardMaterial) {
  const signature = [m.color.getHex(), m.emissive.getHex(), m.emissiveIntensity, m.metalness, m.toneMapped].join('/');
  const cached = ramps.get(m);
  if (cached?.signature === signature) return cached.pixels;
  const pixels = new Uint32Array(STEPS * STEPS);
  const f0 = new THREE.Color(0.04, 0.04, 0.04).lerp(m.color, m.metalness);
  for (let s = 0; s < STEPS; s++) {
    const specular = s * 4 / (STEPS - 1);
    for (let d = 0; d < STEPS; d++) {
      const diffuse = d * 2 / (STEPS - 1) * (1 - m.metalness);
      pixels[s * STEPS + d] = outputPixel(
        m.color.r * diffuse + f0.r * specular + m.emissive.r * m.emissiveIntensity,
        m.color.g * diffuse + f0.g * specular + m.emissive.g * m.emissiveIntensity,
        m.color.b * diffuse + f0.b * specular + m.emissive.b * m.emissiveIntensity, m.toneMapped);
    }
  }
  ramps.set(m, { signature, pixels });
  return pixels;
}

export class SoftwareLighting {
  private normal = new THREE.Vector3();
  private normalMatrix = new THREE.Matrix3();
  private view = new THREE.Vector3();
  private half = new THREE.Vector3();
  private fill = new THREE.Vector3(24, 14, -18).normalize();
  private key = new THREE.Vector3(-18, 32, 14).normalize();
  private ramp: Uint32Array = new Uint32Array(0);
  private gloss = 12;
  private specularScale = 1;

  prepare(material: THREE.MeshStandardMaterial, world: THREE.Matrix4, camera: THREE.Vector3) {
    this.normalMatrix.getNormalMatrix(world);
    this.view.setFromMatrixPosition(world).sub(camera).negate().normalize();
    this.half.addVectors(this.view, this.key).normalize();
    this.ramp = materialRamp(material);
    this.gloss = 2 + (1 - material.roughness) ** 3 * 110;
    this.specularScale = 0.8 + 0.12 * this.gloss;
  }

  color(x: number, y: number, z: number) {
    const n = this.normal.set(x, y, z).applyMatrix3(this.normalMatrix).normalize();
    const key = Math.max(0, n.dot(this.key));
    const sky = (n.y + 1) * 0.5;
    const diffuse = 0.25 + 0.50 * sky + 0.65 * key + 0.18 * Math.max(0, n.dot(this.fill));
    const fresnel = (1 - Math.max(0, n.dot(this.view))) ** 5;
    const specular = 0.18 + sky * sky * 0.85 + fresnel * 0.8
      + this.specularScale * Math.max(0, n.dot(this.half)) ** this.gloss;
    const d = Math.min(STEPS - 1, Math.round(diffuse * (STEPS - 1) / 2));
    const s = Math.min(STEPS - 1, Math.round(specular * (STEPS - 1) / 4));
    return this.ramp[s * STEPS + d];
  }
}
