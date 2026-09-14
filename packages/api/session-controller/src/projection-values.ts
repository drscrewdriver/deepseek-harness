/** Projection values on their way to a JSON transport. */

import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionProjectionValues } from './types.ts'

/**
 * Keep the cells of one projection payload that a JSON transport carries
 * unchanged, and report the rest.
 *
 * A projection definition validates its value with its `viewSchema`, which
 * accepts values JSON cannot carry (a `Map`, a `Date`, a property whose value
 * is `undefined`). The two transports then fail apart: a forwarded host event
 * rejects whole on the first such cell, while a Remote stream item is
 * `JSON.stringify`-ed with no JSON check and silently corrupts it. Dropping
 * the cell leaves consumers with the "no value at this cut" reading they
 * already have for an absent projection.
 * @param values - whole values per projection key.
 * @param onDropped - called once per dropped key with that key.
 * @returns the surviving cells in input order.
 */
export function losslessProjectionValues(
  values: Readonly<Record<string, unknown>>,
  onDropped: (key: string) => void,
): SessionProjectionValues {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isJsonValue(value)) {
      kept[key] = value
      continue
    }
    onDropped(key)
  }
  // Every surviving entry passed `isJsonValue`, which is exactly the
  // `SessionProjectionValue` contract; the check is a boolean rather than a
  // type predicate by design, so the result is asserted once here.
  return kept as SessionProjectionValues
}
