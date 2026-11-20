import * as THREE from 'three';
import type { Drawable, SoftwareViewport } from './softwareViewport';

type PaintedMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>;

interface SurfaceState {
  world: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  color: THREE.Color;
  emission: THREE.Color;
  intensity: number;
  eligibleAt: number;
  surfaceVersion: number;
  roughness: number;
  metalness: number;
  opacity: number;
  seen: number;
}

// A stationary camera can reuse the opaque color and depth of stationary parts.
// Animated parts and transparent layers still draw against that depth every frame.
export class SoftwareSurfaceCache {
  readonly surfaces = new Set<Drawable>();
  private states = new WeakMap<Drawable, SurfaceState>();
  private transform = new THREE.Matrix4();
  private region = '';
  private lastViewChange = 0;
  private frame = 0;
  private lastCapture = 0;
  private valid = false;
  private colors: Uint32Array = new Uint32Array(0);
  private depths: Float32Array = new Float32Array(0);

  prepare(objects: Drawable[], projection: THREE.Matrix4, viewport: SoftwareViewport, ratioWidth: number, ratioHeight: number,
    stride: number, bufferLength: number, now: number): 'capture' | 'restore' | 'redraw' {
    this.frame++;
    // Partial edge tiles may change size after a resize without moving their origin.
    const region = [viewport.left, viewport.top, viewport.width, viewport.height, viewport.scale, ratioWidth, ratioHeight, stride, bufferLength].join('/');
    if (!this.transform.equals(projection) || this.region !== region) {
      this.transform.copy(projection);
      this.region = region;
      this.lastViewChange = now;
      this.valid = false;
    }
    let seenCached = 0;
    let newlyStable = 0;
    for (const object of objects) {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) continue;
      const mesh = object as PaintedMesh;
      const m = mesh.material;
      const emission = 'emissive' in m ? m.emissive : m.color;
      const intensity = 'emissiveIntensity' in m ? m.emissiveIntensity : 0;
      const roughness = 'roughness' in m ? m.roughness : 0;
      const metalness = 'metalness' in m ? m.metalness : 0;
      let state = this.states.get(mesh);
      if (!state) {
        state = { world: mesh.matrixWorld.clone(), geometry: mesh.geometry, material: m, color: m.color.clone(),
          emission: emission.clone(), intensity, eligibleAt: now + 400, surfaceVersion: m.version, roughness, metalness, opacity: m.opacity, seen: this.frame };
        this.states.set(mesh, state);
      } else if (state.seen !== this.frame - 1 || !state.world.equals(mesh.matrixWorld) || state.geometry !== mesh.geometry ||
        state.material !== m || !state.color.equals(m.color) || !state.emission.equals(emission) || state.intensity !== intensity ||
        state.surfaceVersion !== m.version || state.roughness !== roughness || state.metalness !== metalness || state.opacity !== m.opacity) {
        state.world.copy(mesh.matrixWorld);
        state.geometry = mesh.geometry;
        state.material = m;
        state.color.copy(m.color);
        state.emission.copy(emission);
        state.intensity = intensity;
        state.surfaceVersion = m.version;
        state.roughness = roughness;
        state.metalness = metalness;
        state.opacity = m.opacity;
        // Blinking lights and intermittent machinery can hold still for several frames.
        state.eligibleAt = now + 5000;
        if (this.surfaces.has(mesh)) this.valid = false;
      }
      state.seen = this.frame;
      if (this.surfaces.has(mesh)) seenCached++;
      else if (now >= state.eligibleAt) newlyStable++;
    }
    if (seenCached !== this.surfaces.size) this.valid = false;
    if (this.valid && !(newlyStable && now - this.lastCapture > 2500)) return 'restore';
    this.surfaces.clear();
    if (now - this.lastViewChange < 160) return 'redraw';
    for (const mesh of objects) {
      const state = this.states.get(mesh);
      if (state && now >= state.eligibleAt) this.surfaces.add(mesh);
    }
    this.lastCapture = now;
    return this.surfaces.size ? 'capture' : 'redraw';
  }

  capture(pixels: Uint32Array, depth: Float32Array) {
    if (this.colors.length !== pixels.length) {
      this.colors = new Uint32Array(pixels.length);
      this.depths = new Float32Array(depth.length);
    }
    this.colors.set(pixels);
    this.depths.set(depth);
    this.valid = true;
  }

  restore(pixels: Uint32Array, depth: Float32Array) {
    pixels.set(this.colors);
    depth.set(this.depths);
  }
}
