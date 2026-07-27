const cloneValue = <T>(value: T, seen: WeakMap<object, unknown>): T => {
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) clone.push(cloneValue(entry, seen));
    return Object.freeze(clone) as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneValue((value as Record<string, unknown>)[key], seen),
      writable: true,
    });
  }
  return Object.freeze(clone) as T;
};

/** Clone normalized Protocol data and freeze every exposed object and array. */
export const cloneImmutable = <T>(value: T): T =>
  cloneValue(value, new WeakMap<object, unknown>());

export const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      deepEqual(leftRecord[key], rightRecord[key]),
  );
};
