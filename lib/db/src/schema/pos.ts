import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    pinHash: text("pin_hash").notNull(),
    permissions: jsonb("permissions")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_pin_hash_idx").on(table.pinHash)],
);

export const shiftsTable = pgTable(
  "shifts",
  {
    id: serial("id").primaryKey(),
    shiftDate: date("shift_date").notNull(),
    master: text("master").notNull(),
    partner: text("partner"),
    rebuys: integer("rebuys").notNull().default(0),
    helpersPay: integer("helpers_pay").notNull().default(0),
    shiftComment: text("shift_comment"),
    fixedRate: boolean("fixed_rate").notNull().default(false),
    fixedSalary: integer("fixed_salary"),
    revenue: integer("revenue").notNull().default(0),
    payroll: integer("payroll").notNull().default(0),
    coalUsedKg: numeric("coal_used_kg", { precision: 10, scale: 3 })
      .notNull()
      .default("0"),
    tobaccoUsedGrams: numeric("tobacco_used_grams", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("0"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("shifts_shift_date_idx").on(table.shiftDate)],
);

export const shiftLinesTable = pgTable(
  "shift_lines",
  {
    id: serial("id").primaryKey(),
    shiftId: integer("shift_id")
      .notNull()
      .references(() => shiftsTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: integer("unit_price").notNull(),
    discountPercent: integer("discount_percent").notNull().default(0),
    discountComment: text("discount_comment"),
    lineTotal: integer("line_total").notNull(),
    tobaccoGramsPerHookah: numeric("tobacco_grams_per_hookah", {
      precision: 6,
      scale: 2,
    }).notNull(),
  },
  (table) => [index("shift_lines_shift_id_idx").on(table.shiftId)],
);

export const inventoryTable = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    itemCode: text("item_code").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("inventory_item_code_idx").on(table.itemCode)],
);

export const settingsTable = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
export type Shift = typeof shiftsTable.$inferSelect;
export type NewShift = typeof shiftsTable.$inferInsert;
export type ShiftLine = typeof shiftLinesTable.$inferSelect;
export type NewShiftLine = typeof shiftLinesTable.$inferInsert;
export type InventoryItem = typeof inventoryTable.$inferSelect;
export type NewInventoryItem = typeof inventoryTable.$inferInsert;
export type Setting = typeof settingsTable.$inferSelect;
export type NewSetting = typeof settingsTable.$inferInsert;