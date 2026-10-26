import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { normalizePinsRecord, type PinsRecord } from "./pins";

/**
 * PIN-коды лежат в таблице `settings` (JSON-значение), а не в состоянии кассы:
 * `GET /pos/state` отдаётся любому вошедшему, в том числе работнику, поэтому
 * хеши не должны попадать в документ состояния.
 *
 * Отдельная таблица не нужна — `settings` уже есть в схеме, так что деплою не
 * требуется `drizzle-kit push`.
 */
const SETTINGS_KEY = "pos_pins";

type SettingsRow = { key: string; value: unknown };

async function readSettingsRow(): Promise<SettingsRow | null> {
  const rows: SettingsRow[] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, SETTINGS_KEY))
    .limit(1);
  return rows[0] ?? null;
}

/** Сохранённые коды или null, если владелец ещё не менял дефолтные. */
export async function loadPins(): Promise<PinsRecord | null> {
  const row = await readSettingsRow();
  return normalizePinsRecord(row?.value);
}

/** Записывает коды (переданные поля заменяются, остальные сохраняются). */
export async function savePins(pins: PinsRecord): Promise<PinsRecord> {
  const next: PinsRecord = { ...pins, updatedAt: new Date().toISOString() };
  const row = await readSettingsRow();
  if (row) {
    await db
      .update(settingsTable)
      .set({ value: next, updatedAt: new Date() })
      .where(eq(settingsTable.key, SETTINGS_KEY));
  } else {
    await db
      .insert(settingsTable)
      .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoNothing();
  }
  return next;
}
