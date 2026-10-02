import { integer, jsonb, pgTable, timestamp } from "drizzle-orm/pg-core";

export const posStateTable = pgTable("pos_state", {
  id: integer("id").primaryKey(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});