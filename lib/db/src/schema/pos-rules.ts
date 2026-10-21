import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const posRulesTable = pgTable(
  "pos_rules",
  {
    id: serial("id").primaryKey(),
    // Название правила, например «Расход на фруктовую чашу»
    name: text("name").notNull(),
    // Целевой материал: 'coal' | 'tobacco' | 'other'
    targetMaterial: text("target_material").notNull(),
    // ID позиции склада, с которой списывается расход
    inventoryId: integer("inventory_id")
      .notNull()
      .references(() => inventoryTable.id, { onDelete: "cascade" }),
    // Расход за одну операцию в единицах позиции склада (г или кг)
    amount: numeric("amount", { precision: 10, scale: 3 }).notNull(),
    // Тип операции: 'sale' — при продаже позиции, 'rebuild' — при перезабиве
    operation: text("operation").notNull(), // 'sale' | 'rebuild'
    // Для operation=sale: только строки этой позиции меню; null — любые
    menuItemId: text("menu_item_id"),
    // Включено ли правило
    enabled: boolean("enabled").notNull().default(true),
    // Порядок сортировки (опционально)
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("pos_rules_inventory_operation_idx").on(table.inventoryId, table.operation, table.menuItemId)],
);

export type PosRule = typeof posRulesTable.$inferSelect;
export type NewPosRule = typeof posRulesTable.$inferInsert;