import { supportsInteractiveTransactions } from "./client.js";

/**
 * Read → conditional write → confirmation read, as one atomic unit, on every
 * supported dialect.
 *
 * A dialect without interactive transactions cannot hold a `BEGIN` open across
 * round trips: `db.transaction()` issues a bare `BEGIN` and is rejected, so a
 * template that expressed this pattern as a transaction simply could not write
 * there. What such a dialect does offer is `batch()`, which runs a fixed list of
 * statements as an implicit transaction — enough for the part that actually
 * needs atomicity.
 *
 * The capability branch lives here rather than at the call site, per the
 * architecture contract: app and template code uses the shared query builder and
 * never asks which database it is on. One implementation, one branch, so the
 * dialects cannot drift apart.
 *
 * What each path guarantees:
 *
 * - **Interactive dialects** (SQLite/libSQL, Postgres): all three steps run
 *   inside one transaction.
 * - **Without the capability**: the initial read runs first, then the write and
 *   the confirmation read run together in one `batch()`. A sibling writer may
 *   therefore commit between the read and the write — which is why the write
 *   must be a compare-and-swap predicated on what the read saw, and why the
 *   confirmation read is what proves this attempt won. Both are the caller's
 *   responsibility and both are why this helper is shaped as read/plan/confirm
 *   rather than as a generic "run these statements".
 *
 * A caller that cannot express its write as a CAS must not use this helper where
 * the capability is absent: the guarantee it would need is not available there,
 * and pretending otherwise would be a silently weaker concurrency contract.
 */

/** Minimal surface this helper needs; both a Drizzle db and a tx satisfy it. */
type QueryExecutor = unknown;

/** A built Drizzle query. Awaited interactively, or handed to batch(). */
type BuiltQuery = PromiseLike<unknown>;

export interface CompareAndSwapPlan<TConfirmed> {
  /** The conditional write, predicated on what `read` returned. */
  write: BuiltQuery;
  /** The read that proves this attempt's write landed. */
  confirm: PromiseLike<TConfirmed>;
}

export interface CompareAndSwapOptions<TCurrent, TConfirmed> {
  /** Reads the current row. Throwing here aborts before anything is written. */
  read: (exec: QueryExecutor) => Promise<TCurrent>;
  /** Builds the CAS write and its confirmation read from what `read` saw. */
  plan: (
    exec: QueryExecutor,
    current: TCurrent,
  ) => CompareAndSwapPlan<TConfirmed>;
}

export interface CompareAndSwapResult<TCurrent, TConfirmed> {
  current: TCurrent;
  confirmed: TConfirmed;
}

interface BatchCapableDb {
  batch: (queries: readonly BuiltQuery[]) => Promise<unknown[]>;
}

interface TransactionCapableDb {
  transaction: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

export async function runCompareAndSwap<TCurrent, TConfirmed>(
  db: unknown,
  { read, plan }: CompareAndSwapOptions<TCurrent, TConfirmed>,
): Promise<CompareAndSwapResult<TCurrent, TConfirmed>> {
  if (!supportsInteractiveTransactions()) {
    const batchable = db as BatchCapableDb;
    if (typeof batchable.batch !== "function") {
      // A dialect with no interactive transactions whose client also cannot
      // batch is broken wiring, not a slower path: falling through to
      // `transaction()` would fail on `BEGIN` and name the wrong cause.
      throw new Error(
        "[db] The active dialect has no interactive transactions and resolved " +
          "a database client with no batch(); an atomic compare-and-swap " +
          "cannot be performed. Check the database binding wiring.",
      );
    }
    const current = await read(db);
    const { write, confirm } = plan(db, current);
    const results = await batchable.batch([write, confirm]);
    return { current, confirmed: results[1] as TConfirmed };
  }

  const transactional = db as TransactionCapableDb;
  return transactional.transaction(async (tx) => {
    const current = await read(tx);
    const { write, confirm } = plan(tx, current);
    await write;
    return { current, confirmed: await confirm };
  });
}
