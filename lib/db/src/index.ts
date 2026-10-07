import { drizzle } from "drizzle-orm/node-postgres";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

type FallbackStore = Map<string, Record<string, unknown>[]>;

// Демо-режим без Postgres: состояние складывается в JSON-файл, чтобы смены,
// склад и меню переживали перезапуск процесса (для работы всё равно нужен
// стабильный хостинг и, желательно, Postgres).
const stateFile = process.env.POS_STATE_FILE?.trim() || path.resolve(process.cwd(), ".data", "pos-state.json");

const loadStateFile = (): FallbackStore => {
  try {
    if (!existsSync(stateFile)) return new Map();
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Record<string, unknown>[]>;
    return new Map(Object.entries(parsed));
  } catch (error) {
    console.error(`[db] Не удалось прочитать ${stateFile}, стартуем с пустого состояния:`, error);
    return new Map();
  }
};

let persistFailureLogged = false;
const persistStateFile = (store: FallbackStore): void => {
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    // Пишем через временный файл, чтобы обрыв записи не портил состояние.
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(store), null, 2));
    writeFileSync(stateFile, readFileSync(tmp));
    persistFailureLogged = false;
  } catch (error) {
    if (!persistFailureLogged) {
      persistFailureLogged = true;
      console.error(`[db] Не удалось сохранить ${stateFile} — данные останутся только в памяти:`, error);
    }
  }
};

// The in-memory fallback must keep every write in one shared store: `db` and the
// transaction handle passed to `db.transaction(...)` have to observe the same
// rows, otherwise saves are reported as successful but silently dropped.
const createFallbackDb = (store?: FallbackStore) => {
  const state: FallbackStore = store ?? loadStateFile();

  const getRows = <T extends Record<string, unknown>>(table: { _?: { name?: string }; name?: string }) => {
    const tableName = table?._?.name ?? table?.name ?? "unknown";
    if (!state.has(tableName)) {
      state.set(tableName, []);
    }
    return state.get(tableName) as T[];
  };

  const query = <T extends Record<string, unknown>>(table: { _?: { name?: string }; name?: string }) => {
    const rows = getRows<T>(table);
    return {
      where: () => query<T>(table),
      limit: async (limit: number) => rows.slice(0, limit),
      for: async () => rows.slice(),
    };
  };

  return {
    select: () => ({
      from: <T extends Record<string, unknown>>(table: { _?: { name?: string }; name?: string }) => query<T>(table),
    }),
    insert: (table: { _?: { name?: string }; name?: string }) => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          const rows = getRows<Record<string, unknown>>(table);
          if (!rows.some((row) => row.id === value.id)) {
            rows.push(value);
            persistStateFile(state);
          }
        },
      }),
    }),
    update: (table: { _?: { name?: string }; name?: string }) => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          const rows = getRows<Record<string, unknown>>(table);
          if (!rows.length) {
            rows.push(value);
          } else {
            const first = rows[0];
            rows[0] = { ...first, ...value };
          }
          persistStateFile(state);
        },
      }),
    }),
    transaction: async <T>(runner: (tx: unknown) => Promise<T>) => runner(createFallbackDb(state)),
  };
};

let pool: pg.Pool | null = null;
let db: any;

if (!process.env.DATABASE_URL) {
  pool = null as unknown as pg.Pool;
  db = createFallbackDb();
} else {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });
}

export { pool, db };
export * from "./schema";
