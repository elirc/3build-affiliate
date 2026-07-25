/**
 * Whitelisted sorting for SQL.
 *
 * A sort key arrives from a query string, and a query string is attacker
 * input. Interpolating it into `ORDER BY` is a textbook injection, and it is
 * the one place people reach for interpolation because a column name cannot be
 * a bind parameter.
 *
 * So the client's string is never used as SQL. It is used to *look up* a
 * column expression we wrote ourselves, and anything not in the map falls back
 * to the default. The value crossing into the query is always one of ours.
 */

export interface SortSpec<TKey extends string> {
  /** Client key → the SQL fragment it selects. Both written by us. */
  columns: Record<TKey, string>;
  defaultKey: TKey;
  defaultDirection?: 'asc' | 'desc';
}

export interface ResolvedSort {
  column: string;
  direction: 'ASC' | 'DESC';
  /** Echoed back so a UI can show which column is actually sorted. */
  key: string;
}

export function resolveSort<TKey extends string>(
  spec: SortSpec<TKey>,
  requestedKey: string | undefined,
  requestedDirection: string | undefined
): ResolvedSort {
  const key = (
    requestedKey && requestedKey in spec.columns ? requestedKey : spec.defaultKey
  ) as TKey;

  const direction =
    requestedDirection === 'asc'
      ? 'ASC'
      : requestedDirection === 'desc'
        ? 'DESC'
        : (spec.defaultDirection ?? 'desc') === 'asc'
          ? 'ASC'
          : 'DESC';

  return { column: spec.columns[key], direction, key };
}
