import type * as THREE from 'three';

type Disposable = THREE.BufferGeometry | THREE.Material | THREE.Texture;

/**
 * Records every GPU-backed resource the render adapter creates and whether it was disposed.
 * It listens to three's own `dispose` events, so it checks the real disposal path rather than
 * the tracker's bookkeeping. Used by unit tests to prove rig / environment / plan changes do
 * not leak.
 */
export class ResourceLedger {
  created = { geometries: 0, materials: 0, textures: 0 };
  disposed = { geometries: 0, materials: 0, textures: 0 };
  private readonly live = new Set<Disposable>();

  record(resource: Disposable): void {
    if (this.live.has(resource)) return;
    const kind = kindOf(resource);
    this.created[kind] += 1;
    this.live.add(resource);
    const onDispose = (): void => {
      if (!this.live.delete(resource)) return;
      this.disposed[kind] += 1;
      resource.removeEventListener('dispose', onDispose);
    };
    resource.addEventListener('dispose', onDispose);
  }

  liveCount(): { geometries: number; materials: number; textures: number; total: number } {
    let geometries = 0;
    let materials = 0;
    let textures = 0;
    for (const r of this.live) {
      const k = kindOf(r);
      if (k === 'geometries') geometries++;
      else if (k === 'materials') materials++;
      else textures++;
    }
    return { geometries, materials, textures, total: geometries + materials + textures };
  }
}

function kindOf(r: Disposable): 'geometries' | 'materials' | 'textures' {
  if ((r as THREE.BufferGeometry).isBufferGeometry) return 'geometries';
  if ((r as THREE.Material).isMaterial) return 'materials';
  return 'textures';
}

/**
 * Owns a set of resources that are created together and disposed together (one humanoid, one
 * environment, one overlay layer...).
 */
export class ResourceTracker {
  private readonly items = new Set<Disposable>();
  private readonly ledger: ResourceLedger | null;

  constructor(ledger: ResourceLedger | null = null) {
    this.ledger = ledger;
  }

  track<T extends Disposable>(resource: T): T {
    this.items.add(resource);
    this.ledger?.record(resource);
    return resource;
  }

  /** Dispose and forget one resource (e.g. a polyline geometry being replaced). */
  release(resource: Disposable | null | undefined): void {
    if (!resource || !this.items.has(resource)) return;
    this.items.delete(resource);
    resource.dispose();
  }

  disposeAll(): void {
    for (const r of this.items) r.dispose();
    this.items.clear();
  }

  counts(): { geometries: number; materials: number; textures: number } {
    let geometries = 0;
    let materials = 0;
    let textures = 0;
    for (const r of this.items) {
      const k = kindOf(r);
      if (k === 'geometries') geometries++;
      else if (k === 'materials') materials++;
      else textures++;
    }
    return { geometries, materials, textures };
  }

  get size(): number {
    return this.items.size;
  }
}
