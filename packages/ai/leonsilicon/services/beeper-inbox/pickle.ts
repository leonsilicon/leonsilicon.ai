import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { MatrixStore, PickleClient, PickleClientOptions } from "#types";

/**
 * Loads the vendored Pickle build. The deploy puts `@beeper/pickle` and `@beeper/pickle-state-sqlite`
 * (built from the pinned revision, see apps/beeper-inbox) under `<home>/node_modules`, where Node's
 * own resolution also finds them for the adapter's `import "@beeper/pickle"`.
 */
export interface PickleRuntime {
  createMatrixClient(options: PickleClientOptions): PickleClient;
  createStore(db: DatabaseSync): MatrixStore;
}

export async function loadPickle(vendorDir: string): Promise<PickleRuntime> {
  const node = (await import(
    pathToFileURL(join(vendorDir, "@beeper/pickle/dist/node.js")).href
  )) as {
    createMatrixClient(options: PickleClientOptions): PickleClient;
  };
  const sqlite = (await import(
    pathToFileURL(join(vendorDir, "@beeper/pickle-state-sqlite/dist/index.js")).href
  )) as {
    SQLiteMatrixStore: new (db: DatabaseSync) => MatrixStore;
  };
  return {
    createMatrixClient: (options) => node.createMatrixClient(options),
    createStore: (db) => new sqlite.SQLiteMatrixStore(db),
  };
}
