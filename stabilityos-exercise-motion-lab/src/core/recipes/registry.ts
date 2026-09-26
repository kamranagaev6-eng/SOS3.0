import { diag } from '../contracts/diagnostics.ts';
import type { ParamRecord } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { heelRaiseRecipe } from './heelRaise.ts';
import { sitToStandRecipe } from './sitToStand.ts';
import { squatRecipe } from './squat.ts';
import { stepUpDownRecipe } from './stepUpDown.ts';
import type { CompileResult, RecipeDefinition } from './types.ts';

const RECIPES: RecipeDefinition[] = [sitToStandRecipe, squatRecipe, stepUpDownRecipe, heelRaiseRecipe];

export function listRecipes(): readonly RecipeDefinition[] {
  return RECIPES;
}

/** Lookup by explicit id only. No fuzzy matching, no inference from names. */
export function getRecipe(id: string): RecipeDefinition | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}

export function compileRecipe(recipeId: string, params: ParamRecord, rig: RigDefinition): CompileResult {
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    return {
      ok: false,
      plan: null,
      diagnostics: [
        diag('UNKNOWN_RECIPE', 'error', `Unknown recipe id '${recipeId}'. Recipes are selected by explicit id only.`, {
          hint: `Known ids: ${RECIPES.map((r) => r.id).join(', ')}`,
        }),
      ],
    };
  }
  return recipe.compile(params, rig);
}
