import * as THREE from 'three';
import type { Drawable } from './softwareViewport';
import { pixel } from './softwareLighting';

interface Point { x: number; y: number }

function turn(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// Project each shadow caster's bounds onto the platform along the key light.
// A single soft mask keeps overlapping shadows from darkening repeatedly.
export class SoftwareShadows {
  private canvas = document.createElement('canvas');
  private context = this.canvas.getContext('2d', { willReadFrequently: true });
  private matrix = new THREE.Matrix4();
  private flatten = new THREE.Matrix4();
  private points: Point[] = Array.from({ length: 8 }, () => ({ x: 0, y: 0 }));
  private hull: Point[] = [];

  draw(casters: Drawable[], floor: THREE.Mesh, sun: THREE.DirectionalLight, camera: THREE.PerspectiveCamera,
    projection: THREE.Matrix4, fullWidth: number, fullHeight: number, ox: number, oy: number,
    width: number, height: number, stride: number, depth: Float32Array, pixels: Uint32Array) {
    const ctx = this.context;
    if (!ctx) return;
    const step = 4;
    const maskWidth = Math.ceil(width / step), maskHeight = Math.ceil(height / step);
    if (this.canvas.width !== maskWidth) this.canvas.width = maskWidth;
    if (this.canvas.height !== maskHeight) this.canvas.height = maskHeight;
    ctx.clearRect(0, 0, maskWidth, maskHeight);
    if (!floor.geometry.boundingBox) floor.geometry.computeBoundingBox();
    const world = floor.matrixWorld.elements;
    const floorY = world[13] + floor.geometry.boundingBox!.max.y * world[5];
    const sx = sun.position.x / sun.position.y, sz = sun.position.z / sun.position.y;
    this.flatten.set(1, -sx, 0, sx * floorY, 0, 0, 0, floorY, 0, -sz, 1, sz * floorY, 0, 0, 0, 1);
    this.flatten.premultiply(projection);
    ctx.beginPath();
    for (const mesh of casters) {
      if (!mesh.castShadow || mesh.userData.partId === 'infra' || !mesh.geometry.boundingBox) continue;
      const box = mesh.geometry.boundingBox;
      const m = this.matrix.multiplyMatrices(this.flatten, mesh.matrixWorld).elements;
      let count = 0;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? box.max.x : box.min.x;
        const y = i & 2 ? box.max.y : box.min.y;
        const z = i & 4 ? box.max.z : box.min.z;
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (w <= camera.near) break;
        const point = this.points[i];
        point.x = ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * fullWidth / 2 - ox) / step;
        point.y = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * fullHeight / 2 - oy) / step;
        count++;
      }
      if (count === 8) this.addHull(ctx);
    }
    ctx.filter = 'blur(0.8px)';
    ctx.fill();
    const mask = ctx.getImageData(0, 0, maskWidth, maskHeight).data;

    // A plane's reciprocal camera depth is affine in screen space. Only pixels
    // at the platform's depth receive the shadow; nearby pipes and parts occlude it.
    const cm = camera.matrixWorld.elements, pm = camera.projectionMatrix.elements;
    const dy = floorY - cm[13];
    if (Math.abs(dy) < 1e-6) return;
    const dxDepth = 2 * cm[1] / (pm[0] * fullWidth * dy);
    const dyDepth = -2 * cm[5] / (pm[5] * fullHeight * dy);
    const origin = (cm[1] * (pm[8] - 1) / pm[0] + cm[5] * (pm[9] + 1) / pm[5] - cm[9]) / dy
      + (ox + 0.5) * dxDepth + (oy + 0.5) * dyDepth;
    for (let my = 0; my < maskHeight; my++) {
      for (let mx = 0; mx < maskWidth; mx++) {
        const offset = (my * maskWidth + mx) * 4 + 3;
        const a = mask[offset], b = mx + 1 < maskWidth ? mask[offset + 4] : a;
        const below = my + 1 < maskHeight ? offset + maskWidth * 4 : offset;
        const c = mask[below], d = mx + 1 < maskWidth ? mask[below + 4] : c;
        if (!(a || b || c || d)) continue;
        const x = mx * step, y = my * step;
        for (let row = 0; row < step && y + row < height; row++) {
          const v = row / step;
          const start = a + (c - a) * v, end = b + (d - b) * v;
          let z = origin + (y + row) * dyDepth + x * dxDepth;
          for (let col = 0; col < step && x + col < width; col++, z += dxDepth) {
            const at = (y + row) * stride + x + col;
            if (!depth[at] || Math.abs(depth[at] - z) > z * 0.00002) continue;
            const light = 1 - (start + (end - start) * col / step) * (0.095 / 255);
            const p = pixels[at];
            pixels[at] = pixel((p & 255) * light, ((p >>> 8) & 255) * light, ((p >>> 16) & 255) * light);
          }
        }
      }
    }
  }

  private addHull(ctx: CanvasRenderingContext2D) {
    const points = this.points.sort((a, b) => a.x - b.x || a.y - b.y);
    const hull = this.hull;
    hull.length = 0;
    for (const point of points) {
      while (hull.length > 1 && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
      hull.push(point);
    }
    const lower = hull.length;
    for (let i = points.length - 2; i >= 0; i--) {
      const point = points[i];
      while (hull.length > lower && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
      hull.push(point);
    }
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
  }
}
