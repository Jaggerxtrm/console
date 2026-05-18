export const COMPATIBLE_RANGE = { min: 1, max: 1 } as const;

export function isCompatible(version: number): boolean {
  return version >= COMPATIBLE_RANGE.min && version <= COMPATIBLE_RANGE.max;
}
