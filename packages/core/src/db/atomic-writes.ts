import { supportsInteractiveTransactions } from "./client.js";

/**
 * Run a fixed list of writes as one atomic unit on every supported dialect.
 *
 * Companion to `runCompareAndSwap`, for the other half of the problem it
 * describes. A dialect without interactive transactions cannot hold a `BEGIN`
 * open, so `db.transaction()` fails outright there. Where `runCompareAndSwap`
 * covers read → conditional write → confirm, this covers the far more common
 * "insert these N rows together, or none of them" — which a batched statement
 * list runs as an implicit transaction, giving exactly that guarantee.
 *
 * The capability branch lives here rather than at the call site, per the
 * architecture contract: app and template code uses the shared query builder
 * and never asks which database it is on. One implementation, one branch, so
 * the dialects cannot drift apart.
 *
 * `build` must return every statement up front and must not depend on a
 * previous statement's result — that is what makes the batched path possible at
 * all. A write sequence that needs to read its own intermediate state is an
 * interactive transaction, and belongs in `runCompareAndSwap` (or nowhere,
 * where the capability is absent) rather than being reshaped until it
 * type-checks here.
 */

/** Minimal surface this helper needs; both a Drizzle db and a tx satisfy it. */
type QueryExecutor = unknown;

/** A built Drizzle query. Awaited interactively, or handed to batch(). */
type BuiltQuery = PromiseLike<unknown>;

interface BatchCapableDb {
  batch: (queries: readonly BuiltQuery[]) => Promise<unknown[]>;
}

interface TransactionCapableDb {
  transaction: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

export async function runAtomicWrites(
  db: unknown,
  build: (exec: QueryExecutor) => readonly BuiltQuery[],
): Promise<void> {
  if (!supportsInteractiveTransactions()) {
    const batchable = db as BatchCapableDb;
    if (typeof batchable.batch !== "function") {
      // A dialect with no interactive transactions whose client also cannot
      // batch is broken wiring, not a slower path: falling through to
      // `transaction()` would fail on `BEGIN` and name the wrong cause.
      throw new Error(
        "[db] The active dialect has no interactive transactions and resolved " +
          "a database client with no batch(); these writes cannot be made " +
          "atomic. Check the database binding wiring.",
      );
    }
    const queries = build(db);
    // `batch([])` is a round trip that guarantees nothing; an empty plan is a
    // caller bug worth surfacing rather than a successful no-op write.
    if (queries.length === 0) {
      throw new Error("[db] runAtomicWrites was given no statements to run.");
    }
    await batchable.batch(queries);
    return;
  }

  const transactional = db as TransactionCapableDb;
  await transactional.transaction(async (tx) => {
    const queries = build(tx);
    if (queries.length === 0) {
      throw new Error("[db] runAtomicWrites was given no statements to run.");
    }
    for (const query of queries) await query;
  });
}
