import { z } from "zod";

export const maradiPinSchema = z.string().regex(/^\d{4}$/);

export const maradiStaffNameSchema = z.string().trim().min(1).max(180);

export const maradiRoleSchema = z.enum(["admin", "worker"]);

export const maradiCategorySchema = z.enum([
  "Классика",
  "Грейпфрут",
  "Ананас",
  "Барби",
  "Авторский",
]);

export const maradiPermissionMatrixSchema = z.object({
  categories: z.array(maradiCategorySchema),
  canReceiveInventory: z.boolean(),
  canApplyDiscount: z.boolean(),
  canUseHalfDiscount: z.boolean(),
  canUseFullDiscount: z.boolean(),
  canViewRevenue: z.boolean(),
  canEditShiftHistory: z.boolean(),
});

export const maradiMenuItemSchema = z.object({
  id: z.string(),
  name: maradiCategorySchema,
  price: z.number().int().min(0),
  tobaccoGrams: z.number().int().min(1).max(100),
  enabled: z.boolean(),
  salaryBonus: z.number().nonnegative().optional(),
});

export const maradiInventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(["coal", "tobacco", "consumables", "other"]),
  brand: z.string().default(""),
  packageGrams: z.number().nonnegative(),
  stock: z.number().nonnegative(),
  unit: z.string(),
});

export const maradiContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  tareGrams: z.number().nonnegative(),
});

export const maradiEmployeeSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80),
  baseSalary: z.number().nonnegative(),
  highVolumeSalary: z.number().nonnegative(),
});

export const maradiShiftLineSchema = z.object({
  id: z.string(),
  menuItemId: z.string(),
  menuItemName: z.string(),
  unitPrice: z.number().int().min(0),
  tobaccoGrams: z.number().int().min(1).max(100),
  discount: z.union([z.literal(0), z.literal(50), z.literal(100)]),
  reason: z.string().default(""),
});

export const maradiShiftSchema = z.object({
  id: z.string(),
  date: z.string(),
  master: maradiStaffNameSchema,
  lines: z.array(maradiShiftLineSchema),
  helpersPay: z.number().int().nonnegative(),
  purchaseAmount: z.number().nonnegative().optional(),
  rebuilds: z.number().int().nonnegative().optional(),
  amidExtra: z.number().nonnegative().optional(),
  comment: z.string().default(""),
  fixedSalary: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.string().datetime().or(z.string()),
});

export const maradiPosStateSchema = z.object({
  menu: z.array(maradiMenuItemSchema),
  permissions: maradiPermissionMatrixSchema,
  inventory: z.array(maradiInventoryItemSchema),
  containers: z.array(maradiContainerSchema),
  employees: z.array(maradiEmployeeSchema).optional(),
  shifts: z.array(maradiShiftSchema),
  coalOpeningKg: z.number().nonnegative(),
  updatedAt: z.string().datetime().or(z.string()),
});

export const maradiLoginBodySchema = z.object({
  pin: maradiPinSchema,
});

export type MaradiPin = z.infer<typeof maradiPinSchema>;
export type MaradiStaffName = z.infer<typeof maradiStaffNameSchema>;
export type MaradiRole = z.infer<typeof maradiRoleSchema>;
export type MaradiPermissionMatrix = z.infer<typeof maradiPermissionMatrixSchema>;
export type MaradiMenuItem = z.infer<typeof maradiMenuItemSchema>;
export type MaradiInventoryItem = z.infer<typeof maradiInventoryItemSchema>;
export type MaradiContainer = z.infer<typeof maradiContainerSchema>;
export type MaradiEmployee = z.infer<typeof maradiEmployeeSchema>;
export type MaradiShiftLine = z.infer<typeof maradiShiftLineSchema>;
export type MaradiShift = z.infer<typeof maradiShiftSchema>;
export type MaradiPosState = z.infer<typeof maradiPosStateSchema>;
