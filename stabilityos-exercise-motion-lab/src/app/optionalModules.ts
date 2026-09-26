/**
 * Lazily loaded engine modules that are heavy (glTF export pulls in three's exporter/loader) or
 * developed in parallel (host-rig adapter). `import.meta.glob` resolves at build time and yields
 * an empty map when a file does not exist, so the workbench builds and shows a clear
 * "not available" state instead of failing.
 */
export type AdapterModule = typeof import('../core/adapter/index.ts');
export type SyntheticHostRig = AdapterModule['SYNTHETIC_HOST_RIGS'][number];

export type GltfModule = typeof import('../export/gltf.ts');
export type RecipeIoModule = typeof import('../core/io/recipeIo.ts');

const adapterGlob = import.meta.glob<AdapterModule>('../core/adapter/index.ts');
const gltfGlob = import.meta.glob<GltfModule>('../export/gltf.ts');
const recipeIoGlob = import.meta.glob<RecipeIoModule>('../core/io/recipeIo.ts');

async function load<T>(glob: Record<string, () => Promise<T>>, key: string): Promise<T | null> {
  const loader = glob[key];
  if (!loader) return null;
  return loader();
}

export const moduleAvailability = {
  adapter: '../core/adapter/index.ts' in adapterGlob,
  gltf: '../export/gltf.ts' in gltfGlob,
  recipeIo: '../core/io/recipeIo.ts' in recipeIoGlob,
};

export const loadAdapterModule = (): Promise<AdapterModule | null> => load(adapterGlob, '../core/adapter/index.ts');
export const loadGltfModule = (): Promise<GltfModule | null> => load(gltfGlob, '../export/gltf.ts');
export const loadRecipeIoModule = (): Promise<RecipeIoModule | null> => load(recipeIoGlob, '../core/io/recipeIo.ts');
