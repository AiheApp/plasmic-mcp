/**
 * Token-name normalization shared by the generator, the template library, and
 * the insert-time validator.
 *
 * Studio's web importer resolves `var(--token-<x>)` by comparing
 * toVarName(token.name) === toVarName(x), where toVarName is lodash camelCase
 * (platform/wab/src/wab/commons/StyleToken.ts). Two names therefore match iff
 * they split into the same word sequence. We canonicalize to that word
 * sequence (lowercased, joined by "-") for both our kebab varNames and
 * arbitrary refs found in HTML.
 */

export interface DsToken {
  name: string;
  varName: string;
  type: string;
  value: string;
  uuid: string;
}

/**
 * Split like lodash `words()` on the inputs we deal with: separators
 * (space/-/_) and case/digit boundaries. "Font Size 8xl" and "font-size-8xl"
 * both yield ["font","size","8","xl"].
 */
export function splitWords(s: string): string[] {
  return (
    s
      // camelCase and PascalCase boundaries
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      // letter/digit boundaries
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-zA-Z])/g, "$1 $2")
      .split(/[^a-zA-Z\d]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
  );
}

/** Kebab-case canonical var name for a token name ("Font Size 8xl" → "font-size-8xl"). */
export function toKebabVarName(name: string): string {
  return splitWords(name).join("-");
}

/** Canonical comparison key — two refs match in Studio iff their keys match. */
export function tokenMatchKey(ref: string): string {
  return splitWords(ref).join("-");
}
