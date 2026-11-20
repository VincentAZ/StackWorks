import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PALETTE } from './palette';

// The software path uses the exhibit's scene graph and materials. Curves can use
// fewer facets at this resolution without changing the models used for picking.
function displayGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry instanceof RoundedBoxGeometry) {
    const { width, height, depth, radius } = geometry.parameters as typeof geometry.parameters & { radius: number };
    return new RoundedBoxGeometry(width, height, depth, 1, radius);
  }
  if (geometry instanceof THREE.SphereGeometry) {
    const { radius, widthSegments, heightSegments } = geometry.parameters;
    return new THREE.SphereGeometry(radius, Math.min(widthSegments, 12), Math.min(heightSegments, 8));
  }
  if (geometry instanceof THREE.TorusGeometry) {
    const { radius, tube, radialSegments, tubularSegments, arc } = geometry.parameters;
    return new THREE.TorusGeometry(radius, tube, Math.min(radialSegments, 6), Math.min(tubularSegments, 24), arc);
  }
  return geometry;
}

class Vertex {
  x = 0;
  y = 0;
  z = 0;
  clipX = 0;
  clipY = 0;
  w = 0;

  project(x: number, y: number, w: number, width: number, height: number) {
    this.clipX = x;
    this.clipY = y;
    this.w = w;
    this.z = 1 / w;
    this.x = (1 + x * this.z) * width / 2;
    this.y = (1 - y * this.z) * height / 2;
  }
}

type SurfaceMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
type Drawable = THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial> | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

export class SoftwareRenderer {
  readonly domElement: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private image: ImageData;
  private pixels: Uint32Array;
  private depth: Float32Array;
  private geometries = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  private vertices: Vertex[] = [];
  private clipA = new Vertex();
  private clipB = new Vertex();
  private projection = new THREE.Matrix4();
  private transform = new THREE.Matrix4();
  private instance = new THREE.Matrix4();
  private normalTransform = new THREE.Matrix3();
  private light = new THREE.Vector3(-18, 32, 14).normalize();
  private localLight = new THREE.Vector3();
  private color = new THREE.Color();
  private emissive = new THREE.Color();
  private instanceColor = new THREE.Color();
  private frustum = new THREE.Frustum();
  private transparent: Drawable[] = [];
  private near = 0.1;
  private pixelRatio = 1;
  private background = new THREE.Color(PALETTE.background).getHex();
  private clearPixel = this.pack(this.background >> 16, (this.background >> 8) & 255, this.background & 255);

  constructor(canvas: HTMLCanvasElement) {
    this.domElement = canvas;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.context = context;
    this.image = context.createImageData(1, 1);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.depth = new Float32Array(1);
  }

  setPixelRatio(ratio: number) {
    this.pixelRatio = ratio;
  }

  setSize(cssWidth: number, cssHeight: number) {
    const scale = Math.min(this.pixelRatio, 1.5, Math.sqrt(720_000 / (cssWidth * cssHeight)));
    const width = Math.max(1, Math.round(cssWidth * scale));
    const height = Math.max(1, Math.round(cssHeight * scale));
    if (this.image.width === width && this.image.height === height) return;
    this.domElement.width = width;
    this.domElement.height = height;
    this.image = this.context.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.depth = new Float32Array(width * height);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
    this.near = camera.near;
    this.pixels.fill(this.clearPixel);
    this.depth.fill(0);
    this.transparent.length = 0;
    scene.traverseVisible((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
      if (!object.material.visible || object.material.opacity <= 0.005) return;
      if (object.frustumCulled && !this.frustum.intersectsObject(object)) return;
      if (object.material.transparent) this.transparent.push(object);
      else this.drawObject(object);
    });
    // Sort translucent shells and pipes behind the closer ones. Opaque surfaces
    // already occupy the depth buffer, including packets inside clear pipes.
    const view = camera.matrixWorldInverse.elements;
    const viewZ = (object: Drawable) => {
      const m = object.matrixWorld.elements;
      return view[2] * m[12] + view[6] * m[13] + view[10] * m[14];
    };
    this.transparent.sort((a, b) => viewZ(a) - viewZ(b));
    for (const object of this.transparent) this.drawObject(object);
    this.context.putImageData(this.image, 0, 0);
  }

  private drawObject(object: Drawable) {
    let geometry = this.geometries.get(object.geometry);
    if (!geometry) {
      geometry = displayGeometry(object.geometry);
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
    const width = this.image.width;
    const height = this.image.height;
    const m = this.transform.multiplyMatrices(this.projection, world).elements;
    while (this.vertices.length < position.count) this.vertices.push(new Vertex());
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      this.vertices[i].project(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[3] * x + m[7] * y + m[11] * z + m[15], width, height,
      );
    }
    this.color.copy(material.color);
    if (tint) this.color.multiply(tint);
    if ('emissive' in material) this.color.add(this.emissive.copy(material.emissive).multiplyScalar(material.emissiveIntensity));
    this.color.convertLinearToSRGB();
    const r = Math.min(255, this.color.r * 255);
    const g = Math.min(255, this.color.g * 255);
    const blue = Math.min(255, this.color.b * 255);
    const index = geometry.index?.array;
    const count = index?.length ?? position.count;
    const opacity = material.opacity;
    if (lines) {
      const pixel = this.pack(r, g, blue);
      for (let i = 0; i < count; i += 2) {
        this.line(this.vertices[index?.[i] ?? i], this.vertices[index?.[i + 1] ?? i + 1], pixel, opacity);
      }
      return;
    }

    // Transform the lighting direction once per mesh, then shade its facets.
    this.normalTransform.getNormalMatrix(world).transpose();
    this.localLight.copy(this.light).applyMatrix3(this.normalTransform).normalize();
    const normals = 'emissive' in material ? geometry.getAttribute('normal') : undefined;
    for (let i = 0; i < count; i += 3) {
      const ia = index?.[i] ?? i;
      const ib = index?.[i + 1] ?? i + 1;
      const ic = index?.[i + 2] ?? i + 2;
      const a = this.vertices[ia], b = this.vertices[ib], c = this.vertices[ic];
      if (a.w < this.near && b.w < this.near && c.w < this.near) continue;
      let shade = 1;
      if (normals) {
        const lx = normals.getX(ia) + normals.getX(ib) + normals.getX(ic);
        const ly = normals.getY(ia) + normals.getY(ib) + normals.getY(ic);
        const lz = normals.getZ(ia) + normals.getZ(ib) + normals.getZ(ic);
        shade = 0.81 + 0.19 * (lx * this.localLight.x + ly * this.localLight.y + lz * this.localLight.z) / 3;
      }
      const pixel = this.pack(r * shade, g * shade, blue * shade);
      if (a.w >= this.near && b.w >= this.near && c.w >= this.near) {
        this.triangle(a, b, c, pixel, opacity, material);
      } else {
        this.clipTriangle(a, b, c, pixel, opacity, material);
      }
    }
  }

  // Clip in homogeneous coordinates before dividing by w, including when the
  // camera crosses the platform during an orbit or a close-up.
  private clipTriangle(a: Vertex, b: Vertex, c: Vertex, pixel: number, opacity: number, material: SurfaceMaterial) {
    const points = [a, b, c];
    const clipped: Vertex[] = [];
    let previous = c;
    let intersection = this.clipA;
    for (const point of points) {
      if ((point.w < this.near) !== (previous.w < this.near)) {
        const t = (this.near - previous.w) / (point.w - previous.w);
        intersection.project(previous.clipX + t * (point.clipX - previous.clipX), previous.clipY + t * (point.clipY - previous.clipY),
          this.near, this.image.width, this.image.height);
        clipped.push(intersection);
        intersection = this.clipB;
      }
      if (point.w >= this.near) clipped.push(point);
      previous = point;
    }
    for (let i = 2; i < clipped.length; i++) this.triangle(clipped[0], clipped[i - 1], clipped[i], pixel, opacity, material);
  }

  private triangle(a: Vertex, b: Vertex, c: Vertex, pixel: number, opacity: number, material: SurfaceMaterial) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 0.01 || (area > 0 && material.side === THREE.FrontSide) || (area < 0 && material.side === THREE.BackSide)) return;
    if (a.y > b.y) [a, b] = [b, a];
    if (b.y > c.y) [b, c] = [c, b];
    if (a.y > b.y) [a, b] = [b, a];
    this.scanRows(a, c, a, b, pixel, opacity, material.depthWrite);
    this.scanRows(a, c, b, c, pixel, opacity, material.depthWrite);
  }

  private scanRows(a: Vertex, c: Vertex, top: Vertex, bottom: Vertex, pixel: number, opacity: number, depthWrite: boolean) {
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
      for (let i = y * width + start, limit = y * width + end; i < limit; i++, z += dz) {
        if (z <= this.depth[i]) continue;
        if (depthWrite) this.depth[i] = z;
        this.pixels[i] = opacity >= 1 ? pixel : this.blend(this.pixels[i], pixel, opacity);
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
      if (a.z + (b.z - a.z) * t >= this.depth[offset]) this.pixels[offset] = this.blend(this.pixels[offset], pixel, opacity);
    }
  }

  private pack(r: number, g: number, b: number) {
    return (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  }

  private blend(back: number, front: number, alpha: number) {
    const color = (shift: number) => ((front >>> shift) & 255) * alpha + ((back >>> shift) & 255) * (1 - alpha);
    return this.pack(color(0), color(8), color(16));
  }
}
