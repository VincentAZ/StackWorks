import * as THREE from 'three';

import type { SurfaceMaterial } from './softwareLighting';

export type Drawable = THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial> | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

// Supersample the screen region that contains geometry. On an ultrawide display
// most pixels surround the machine and need only the solid background color.
export class SoftwareViewport {
  private scratch = new THREE.Matrix4();
  private instance = new THREE.Matrix4();
  private minX = 0;
  private minY = 0;
  private maxX = 0;
  private maxY = 0;
  left = 0;
  top = 0;
  width = 1;
  height = 1;
  scale = 1;

  measure(objects: Drawable[], projection: THREE.Matrix4, width: number, height: number, maxScale: number) {
    this.minX = this.minY = 1;
    this.maxX = this.maxY = -1;
    for (const object of objects) {
      const geometry = object.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      if (box.isEmpty()) continue;
      if (object instanceof THREE.InstancedMesh) {
        for (let i = 0; i < object.count; i++) {
          object.getMatrixAt(i, this.instance);
          this.instance.premultiply(object.matrixWorld);
          this.include(box, this.scratch.multiplyMatrices(projection, this.instance));
        }
      } else {
        this.include(box, this.scratch.multiplyMatrices(projection, object.matrixWorld));
      }
    }
    // Snap to tiles so small animations do not reallocate the backing store.
    const tile = 64;
    const left = Math.floor(((this.minX + 1) * width / 2 - 2) / tile) * tile;
    const top = Math.floor(((1 - this.maxY) * height / 2 - 2) / tile) * tile;
    const right = Math.ceil(((this.maxX + 1) * width / 2 + 2) / tile) * tile;
    const bottom = Math.ceil(((1 - this.minY) * height / 2 + 2) / tile) * tile;
    this.left = THREE.MathUtils.clamp(left, 0, width - 1);
    this.top = THREE.MathUtils.clamp(top, 0, height - 1);
    this.width = Math.max(1, Math.min(width, right) - this.left);
    this.height = Math.max(1, Math.min(height, bottom) - this.top);
    const area = this.width * this.height;
    if (maxScale >= 2 && area * 4 <= 6_000_000) this.scale = 2;
    else if (maxScale >= 1.5 && area * 2.25 <= 6_000_000) this.scale = 1.5;
    else this.scale = 1;
  }

  private include(box: THREE.Box3, matrix: THREE.Matrix4) {
    const m = matrix.elements;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? box.max.x : box.min.x;
      const y = i & 2 ? box.max.y : box.min.y;
      const z = i & 4 ? box.max.z : box.min.z;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0.1) {
        this.minX = this.minY = -1;
        this.maxX = this.maxY = 1;
        return;
      }
      const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      this.minX = Math.min(this.minX, px);
      this.maxX = Math.max(this.maxX, px);
      this.minY = Math.min(this.minY, py);
      this.maxY = Math.max(this.maxY, py);
    }
  }
}
