import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';
import { blendPixel, blendTable, composite, outputPixel, pixel, SoftwareLighting, type SurfaceMaterial } from './softwareLighting';
import { SoftwareSurfaceCache } from './softwareSurfaceCache';
import { SoftwareShadows } from './softwareShadows';
import { SoftwareViewport, type Drawable } from './softwareViewport';

class Vertex {
  x = 0;
  y = 0;
  z = 0;
  clipX = 0;
  clipY = 0;
  w = 0;
  color = 0;

  project(x: number, y: number, w: number, width: number, height: number, ox: number, oy: number) {
    this.clipX = x;
    this.clipY = y;
    this.w = w;
    this.z = 1 / w;
    this.x = (1 + x * this.z) * width / 2 - ox;
    this.y = (1 - y * this.z) * height / 2 - oy;
  }
}


// Screen-space derivatives for Gouraud interpolation across a triangle.
class Gradient {
  dx = 0;
  dy = 0;
  base = 0;

  set(a: Vertex, b: Vertex, c: Vertex, va: number, vb: number, vc: number, area: number) {
    this.dx = ((vb - va) * (c.y - a.y) - (vc - va) * (b.y - a.y)) / area;
    this.dy = ((b.x - a.x) * (vc - va) - (c.x - a.x) * (vb - va)) / area;
    this.base = va - this.dx * a.x - this.dy * a.y;
  }

  at(x: number, y: number) { return this.base + x * this.dx + y * this.dy; }
}

export class SoftwareRenderer {
  readonly domElement: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private backing = document.createElement('canvas');
  private backingContext: CanvasRenderingContext2D;
  private viewport = new SoftwareViewport();
  private opaque: Drawable[] = [];
  private visible: Drawable[] = [];
  private red = new Gradient();
  private green = new Gradient();
  private blue = new Gradient();
  private alphaTable: Uint8Array = new Uint8Array(0);
  private lighting = new SoftwareLighting();
  private shadows = new SoftwareShadows();
  private staticCache = new SoftwareSurfaceCache();
  private center = new THREE.Vector3();
  private sortDepths = new WeakMap<Drawable, number>();
  private eye = new THREE.Vector3();
  private fullWidth = 1;
  private fullHeight = 1;
  private offsetX = 0;
  private offsetY = 0;
  private image: ImageData;
  private resolved?: ImageData;
  private pixels: Uint32Array;
  private depth: Float32Array;
  private geometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  private vertices: Vertex[] = [];
  private clipA = new Vertex();
  private clipB = new Vertex();
  private projection = new THREE.Matrix4();
  private transform = new THREE.Matrix4();
  private instance = new THREE.Matrix4();
  private color = new THREE.Color();
  private instanceColor = new THREE.Color();
  private frustum = new THREE.Frustum();
  private transparent: Drawable[] = [];
  private near = 0.1;
  private pixelRatio = 1;
  private sampleScale = 2;
  private background = new THREE.Color(PALETTE.background);
  private clearPixel = outputPixel(this.background.r, this.background.g, this.background.b);

  constructor(canvas: HTMLCanvasElement) {
    this.domElement = canvas;
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.context = context;
    const backingContext = this.backing.getContext('2d', { alpha: false });
    if (!backingContext) throw new Error('Canvas 2D is unavailable.');
    this.backingContext = backingContext;
    this.image = context.createImageData(1, 1);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.depth = new Float32Array(1);
  }

  setPixelRatio(ratio: number, sampleScale = 2) {
    this.pixelRatio = ratio;
    this.sampleScale = sampleScale;
  }

  setSize(cssWidth: number, cssHeight: number) {
    const scale = Math.min(this.pixelRatio, Math.sqrt(16_777_216 / (cssWidth * cssHeight)));
    const width = Math.max(1, Math.round(cssWidth * scale));
    const height = Math.max(1, Math.round(cssHeight * scale));
    if (this.domElement.width === width && this.domElement.height === height) return;
    this.domElement.width = width;
    this.domElement.height = height;
    this.context.fillStyle = `rgb(${this.clearPixel & 255} ${(this.clearPixel >>> 8) & 255} ${(this.clearPixel >>> 16) & 255})`;
    this.context.imageSmoothingQuality = 'high';
    this.context.fillRect(0, 0, width, height);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight) {
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.near = camera.near;
    this.visible.length = this.opaque.length = this.transparent.length = 0;
    let floor: THREE.Mesh | undefined;
    scene.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
      if (!object.material.visible || object.material.opacity <= 0.005) return;
      if (object.frustumCulled && !this.frustum.intersectsObject(object)) return;
      if (object.userData.shadowFloor && object instanceof THREE.Mesh) floor = object;
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
      this.center.copy(object.geometry.boundingSphere!.center).applyMatrix4(object.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      this.sortDepths.set(object, this.center.z);
      this.visible.push(object);
      (object.material.transparent ? this.transparent : this.opaque).push(object);
    });
    const viewRect = this.viewport;
    const { left, top, width, height } = viewRect;
    viewRect.measure(this.visible, this.projection, this.domElement.width, this.domElement.height, this.sampleScale);
    if (left !== viewRect.left || top !== viewRect.top || width !== viewRect.width || height !== viewRect.height) {
      this.context.fillRect(left, top, width, height);
    }
    this.fullWidth = this.domElement.width * viewRect.scale;
    this.fullHeight = this.domElement.height * viewRect.scale;
    this.offsetX = viewRect.left * viewRect.scale;
    this.offsetY = viewRect.top * viewRect.scale;
    const w = Math.ceil(viewRect.width * viewRect.scale), h = Math.ceil(viewRect.height * viewRect.scale);
    if (this.image.width < w || this.image.height < h || this.pixels.length > 3 * w * h) {
      this.backing.width = Math.ceil(w / 128) * 128;
      this.backing.height = Math.ceil(h / 128) * 128;
      this.image = this.backingContext.createImageData(this.backing.width, this.backing.height);
      this.pixels = new Uint32Array(this.image.data.buffer);
      this.depth = new Float32Array(this.pixels.length);
    }
    const mode = this.staticCache.prepare(this.opaque, this.projection, viewRect, this.fullWidth, this.fullHeight,
      this.image.width, this.pixels.length, performance.now());
    // Fill the nearest opaque surfaces first to reject hidden fragments early.
    this.opaque.sort((a, b) => a.renderOrder - b.renderOrder || this.sortDepths.get(b)! - this.sortDepths.get(a)!);
    if (mode === 'restore') {
      this.staticCache.restore(this.pixels, this.depth);
    } else {
      this.pixels.fill(this.clearPixel);
      this.depth.fill(0);
      if (mode === 'capture') {
        for (const object of this.staticCache.surfaces) this.drawObject(object);
        this.staticCache.capture(this.pixels, this.depth);
      }
    }
    for (const object of this.opaque) {
      if (!this.staticCache.surfaces.has(object)) this.drawObject(object);
    }
    if (floor && sun.castShadow) {
      this.shadows.draw(this.opaque, floor, sun, camera, this.projection, this.fullWidth, this.fullHeight,
        this.offsetX, this.offsetY, w, h, this.image.width, this.depth, this.pixels);
    }
    // Sort translucent shells and pipes behind the closer ones. Opaque surfaces
    // already occupy the depth buffer, including packets inside clear pipes.
    this.transparent.sort((a, b) => a.renderOrder - b.renderOrder || this.sortDepths.get(a)! - this.sortDepths.get(b)!);
    for (const object of this.transparent) this.drawObject(object);
    if (viewRect.scale === 1) {
      this.context.putImageData(this.image, viewRect.left, viewRect.top, 0, 0, w, h);
      return;
    }
    if (this.sampleScale > 2 && Number.isInteger(viewRect.scale)) {
      this.resolveSamples(viewRect);
      return;
    }
    this.backingContext.putImageData(this.image, 0, 0, 0, 0, w, h);
    this.context.drawImage(this.backing, 0, 0, viewRect.width * viewRect.scale, viewRect.height * viewRect.scale,
      viewRect.left, viewRect.top, viewRect.width, viewRect.height);
  }

  // Average every sample in a whole-pixel footprint. Canvas drawImage can
  // discard off-center samples when reducing a 3× image to display size.
  private resolveSamples({ left, top, width, height, scale }: SoftwareViewport) {
    if (this.resolved?.width !== width || this.resolved.height !== height) {
      this.resolved = this.context.createImageData(width, height);
    }
    const output = new Uint32Array(this.resolved.data.buffer);
    const stride = this.image.width;
    const count = scale * scale;
    let dest = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let start = y * scale * stride + x * scale;
        let redBlue = 0, green = 0;
        for (let row = 0; row < scale; row++, start += stride) {
          for (let i = start; i < start + scale; i++) {
            const color = this.pixels[i];
            redBlue += color & 0x00ff00ff;
            green += (color >>> 8) & 255;
          }
        }
        output[dest++] = pixel((redBlue & 65535) / count + 0.5, green / count + 0.5, (redBlue >>> 16) / count + 0.5);
      }
    }
    this.context.putImageData(this.resolved, left, top);
  }

  private drawObject(object: Drawable) {
    let geometry = this.geometries.get(object.geometry);
    if (!geometry) {
      // Reuse identical vertices without removing bevels or changing silhouettes.
      geometry = object.geometry.index || object instanceof THREE.LineSegments ? object.geometry : mergeVertices(object.geometry);
      this.geometries.set(object.geometry, geometry);
    }
    if (object instanceof THREE.InstancedMesh) {
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, this.instance);
        this.instance.premultiply(object.matrixWorld);
        if (object.instanceColor) object.getColorAt(i, this.instanceColor);
        this.drawGeometry(geometry, this.instance, object.material, false, object.instanceColor ? this.instanceColor : undefined);
      }
    } else {
      this.drawGeometry(geometry, object.matrixWorld, object.material, object instanceof THREE.LineSegments);
    }
  }

  private drawGeometry(geometry: THREE.BufferGeometry, world: THREE.Matrix4, material: SurfaceMaterial, lines: boolean, tint?: THREE.Color) {
    const position = geometry.getAttribute('position');
    if (!position) return;
    const m = this.transform.multiplyMatrices(this.projection, world).elements;
    const normals = 'emissive' in material ? geometry.getAttribute('normal') : undefined;
    if ('emissive' in material) this.lighting.prepare(material, world, this.eye);
    this.color.copy(material.color);
    if (tint) this.color.multiply(tint);
    const unlit = outputPixel(this.color.r, this.color.g, this.color.b, material.toneMapped);
    while (this.vertices.length < position.count) this.vertices.push(new Vertex());
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      const vertex = this.vertices[i];
      vertex.project(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[3] * x + m[7] * y + m[11] * z + m[15],
        this.fullWidth, this.fullHeight, this.offsetX, this.offsetY,
      );
      vertex.color = normals ? this.lighting.color(normals.getX(i), normals.getY(i), normals.getZ(i)) : unlit;
    }
    const index = geometry.index?.array;
    const count = index?.length ?? position.count;
    const opacity = material.opacity;
    if (opacity < 1) this.alphaTable = blendTable(opacity);
    if (lines) {
      const pixel = unlit;
      for (let i = 0; i < count; i += 2) {
        this.line(this.vertices[index?.[i] ?? i], this.vertices[index?.[i + 1] ?? i + 1], pixel, opacity);
      }
      return;
    }

    for (let i = 0; i < count; i += 3) {
      const ia = index?.[i] ?? i;
      const ib = index?.[i + 1] ?? i + 1;
      const ic = index?.[i + 2] ?? i + 2;
      const a = this.vertices[ia], b = this.vertices[ib], c = this.vertices[ic];
      if (a.w < this.near && b.w < this.near && c.w < this.near) continue;
      if (a.w >= this.near && b.w >= this.near && c.w >= this.near) {
        this.triangle(a, b, c, opacity, material);
      } else {
        this.clipTriangle(a, b, c, opacity, material);
      }
    }
  }

  // Clip in homogeneous coordinates before dividing by w, including when the
  // camera crosses the platform during an orbit or a close-up.
  private clipTriangle(a: Vertex, b: Vertex, c: Vertex, opacity: number, material: SurfaceMaterial) {
    const points = [a, b, c];
    const clipped: Vertex[] = [];
    let previous = c;
    let intersection = this.clipA;
    for (const point of points) {
      if ((point.w < this.near) !== (previous.w < this.near)) {
        const t = (this.near - previous.w) / (point.w - previous.w);
        intersection.project(previous.clipX + t * (point.clipX - previous.clipX), previous.clipY + t * (point.clipY - previous.clipY),
          this.near, this.fullWidth, this.fullHeight, this.offsetX, this.offsetY);
        intersection.color = blendPixel(previous.color, point.color, t);
        clipped.push(intersection);
        intersection = this.clipB;
      }
      if (point.w >= this.near) clipped.push(point);
      previous = point;
    }
    for (let i = 2; i < clipped.length; i++) this.triangle(clipped[0], clipped[i - 1], clipped[i], opacity, material);
  }

  private triangle(a: Vertex, b: Vertex, c: Vertex, opacity: number, material: SurfaceMaterial) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 0.01 || (area > 0 && material.side === THREE.FrontSide) || (area < 0 && material.side === THREE.BackSide)) return;
    const smooth = a.color !== b.color || a.color !== c.color;
    if (smooth) {
      this.red.set(a, b, c, a.color & 255, b.color & 255, c.color & 255, area);
      this.green.set(a, b, c, (a.color >>> 8) & 255, (b.color >>> 8) & 255, (c.color >>> 8) & 255, area);
      this.blue.set(a, b, c, (a.color >>> 16) & 255, (b.color >>> 16) & 255, (c.color >>> 16) & 255, area);
    }
    if (a.y > b.y) [a, b] = [b, a];
    if (b.y > c.y) [b, c] = [c, b];
    if (a.y > b.y) [a, b] = [b, a];
    this.scanRows(a, c, a, b, a.color, opacity, material.depthWrite, smooth);
    this.scanRows(a, c, b, c, a.color, opacity, material.depthWrite, smooth);
  }

  private scanRows(a: Vertex, c: Vertex, top: Vertex, bottom: Vertex, flat: number, opacity: number, depthWrite: boolean, smooth: boolean) {
    const firstRow = Math.max(0, Math.ceil(top.y - 0.5));
    const endRow = Math.min(this.image.height, Math.ceil(bottom.y - 0.5));
    if (firstRow >= endRow) return;
    const width = this.image.width;
    const longSlope = (c.x - a.x) / (c.y - a.y), shortSlope = (bottom.x - top.x) / (bottom.y - top.y);
    const longDepth = (c.z - a.z) / (c.y - a.y), shortDepth = (bottom.z - top.z) / (bottom.y - top.y);
    for (let y = firstRow; y < endRow; y++) {
      let left = a.x + (y + 0.5 - a.y) * longSlope, right = top.x + (y + 0.5 - top.y) * shortSlope;
      let zLeft = a.z + (y + 0.5 - a.y) * longDepth, zRight = top.z + (y + 0.5 - top.y) * shortDepth;
      if (left > right) {
        [left, right] = [right, left];
        [zLeft, zRight] = [zRight, zLeft];
      }
      const start = Math.max(0, Math.ceil(left - 0.5));
      const end = Math.min(width, Math.ceil(right - 0.5));
      if (start >= end) continue;
      const dz = (zRight - zLeft) / (right - left);
      let z = zLeft + dz * (start + 0.5 - left);
      let i = y * width + start;
      const limit = y * width + end;
      if (!smooth && opacity === 1 && depthWrite) {
        for (; i < limit; i++, z += dz) {
          if (z <= this.depth[i]) continue;
          this.depth[i] = z;
          this.pixels[i] = flat;
        }
        continue;
      }
      if (!smooth) {
        for (; i < limit; i++, z += dz) {
          if (z <= this.depth[i]) continue;
          if (depthWrite) this.depth[i] = z;
          this.pixels[i] = opacity >= 1 ? flat : composite(this.pixels[i], flat, this.alphaTable);
        }
        continue;
      }
      let r = this.red.at(start + 0.5, y + 0.5);
      let g = this.green.at(start + 0.5, y + 0.5);
      let b = this.blue.at(start + 0.5, y + 0.5);
      for (; i < limit; i++, z += dz, r += this.red.dx, g += this.green.dx, b += this.blue.dx) {
        if (z <= this.depth[i]) continue;
        if (depthWrite) this.depth[i] = z;
        const color = pixel(r + 0.5, g + 0.5, b + 0.5);
        this.pixels[i] = opacity >= 1 ? color : composite(this.pixels[i], color, this.alphaTable);
      }
    }
  }

  private line(a: Vertex, b: Vertex, pixel: number, opacity: number) {
    if (a.w < this.near || b.w < this.near) return;
    const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      const x = Math.floor(a.x + (b.x - a.x) * t), y = Math.floor(a.y + (b.y - a.y) * t);
      if (x < 0 || x >= this.image.width || y < 0 || y >= this.image.height) continue;
      const offset = y * this.image.width + x;
      if (a.z + (b.z - a.z) * t >= this.depth[offset]) this.pixels[offset] = blendPixel(this.pixels[offset], pixel, opacity);
    }
  }
}
