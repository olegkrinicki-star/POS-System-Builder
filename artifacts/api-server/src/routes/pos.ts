import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, asc } from "drizzle-orm";
import { db, posStateTable, posRulesTable, inventoryTable } from "@workspace/db";
import {
  GetPosStateResponse,
  LoginPosBody,
  SavePosStateBody,
} from "@workspace/api-zod";

const router: IRouter = Router();
const COOKIE_NAME = "maradi_pos_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const isProduction =
  process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT === "1";
// В продакшене секрет обязателен: с известным значением по умолчанию cookie
// сессии можно подделать и войти администратором.
const sessionSecret =
  process.env.SESSION_SECRET ?? (isProduction ? "" : "dev-maradi-pos-secret");
if (!sessionSecret) {
  throw new Error("SESSION_SECRET must be configured to sign POS sessions in production.");
}
// Ставки владельца заведения и мастеров (сверено с таблицей за август-сентябрь 2026).
const DEFAULT_EMPLOYEES = [
  { id: "amid", name: "Амид", baseSalary: 3300, highVolumeSalary: 5000 },
  { id: "oleg", name: "Олег", baseSalary: 2800, highVolumeSalary: 2800 },
  { id: "renat", name: "Ренат", baseSalary: 2500, highVolumeSalary: 2500 },
  { id: "maxim", name: "Максим", baseSalary: 2500, highVolumeSalary: 2500 },
  { id: "kirill", name: "Кирилл", baseSalary: 0, highVolumeSalary: 0 },
];
// Стартовые правила плашки «Правила расчёта» (страница смены). Владелец может
// менять список в интерфейсе; те же дефолты держит клиент в pos-rules.ts.
const DEFAULT_CALCULATION_RULES = [
  { id: 1, name: "Уголь", rule: "125 г на кальян + 125 г на перезабивку" },
  { id: 2, name: "Табак", rule: "24–27 г на чашу + 24 г на перезабивку" },
  {
    id: 3,
    name: "Оклад",
    rule: "Оклад каждому свой; доплата за позиции делится поровну",
  },
];
const MENU_DEFINITIONS = [
  { id: "classic", name: "Классика", price: 1500, tobaccoGrams: 24, salaryBonus: 100 },
  { id: "grapefruit", name: "Грейпфрут", price: 2000, tobaccoGrams: 27, salaryBonus: 150 },
  { id: "pineapple", name: "Ананас", price: 2500, tobaccoGrams: 27, salaryBonus: 150 },
  { id: "barbie", name: "Барби", price: 0, tobaccoGrams: 27, salaryBonus: 0 },
  { id: "signature", name: "Авторский", price: 3600, tobaccoGrams: 27, salaryBonus: 500 },
] as const;
// Автоматическое списание сырья: уголь — 0.125 кг на кальян и 0.125 кг на
// перезабивку чаши, табак — по норме чаши плюс 24 г на каждую перезабивку.
// Это дефолты: администратор переписывает их в `state.usageSettings`, и все
// новые операции считают по сохранённым в БД коэффициентам.
const DEFAULT_USAGE_SETTINGS = {
  coalKgPerHookah: 0.125,
  coalKgPerRebuild: 0.125,
  tobaccoGramsPerRebuild: 24,
} as const;

// Дефолтные правила списания для таблицы pos_rules.
// Инициализируются при первом запуске, если таблица пуста.
const DEFAULT_POS_RULES = [
  {
    name: "Расход угля на кальян",
    targetMaterial: "coal",
    amount: "0.125",
    operation: "sale",
    menuItemId: null,
    enabled: true,
    sortOrder: 1,
  },
  {
    name: "Расход угля на перезабив",
    targetMaterial: "coal",
    amount: "0.125",
    operation: "rebuild",
    menuItemId: null,
    enabled: true,
    sortOrder: 2,
  },
  {
    name: "Расход табака на перезабив",
    targetMaterial: "tobacco",
    amount: "24",
    operation: "rebuild",
    menuItemId: null,
    enabled: true,
    sortOrder: 3,
  },
] as const;
type UsageSettings = {
  coalKgPerHookah: number;
  coalKgPerRebuild: number;
  tobaccoGramsPerRebuild: number;
};

/**
 * Нормализация настроек списания: каждое поле — конечное число ≥ 0, иначе
 * дефолт (дублирует `resolveUsageSettings` из pos-rules.ts — сервер не зависит
 * от клиента, см. «правьте оба места» в replit.md).
 */
function resolveUsageSettings(
  settings?: Partial<UsageSettings> | null,
): UsageSettings {
  const pick = (value: unknown, fallback: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
  };
  return {
    coalKgPerHookah: pick(
      settings?.coalKgPerHookah,
      DEFAULT_USAGE_SETTINGS.coalKgPerHookah,
    ),
    coalKgPerRebuild: pick(
      settings?.coalKgPerRebuild,
      DEFAULT_USAGE_SETTINGS.coalKgPerRebuild,
    ),
    tobaccoGramsPerRebuild: pick(
      settings?.tobaccoGramsPerRebuild,
      DEFAULT_USAGE_SETTINGS.tobaccoGramsPerRebuild,
    ),
  };
}
// Норма табака на чашу — те же границы, что в контракте API (`openapi.yaml`):
// вес чаши задаёт владелец, поле принимает целые 1–100 г.
const MIN_TOBACCO_GRAMS = 1;
const MAX_TOBACCO_GRAMS = 100;
type Role = "admin" | "worker";
type PosState = ReturnType<typeof SavePosStateBody.parse>;

function signPayload(payload: string): string {
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET must be configured to use POS sessions.");
  }
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function createSessionToken(role: Role): string {
  const payload = `${role}.${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}`;
  return `${Buffer.from(payload).toString("base64url")}.${signPayload(payload)}`;
}

function readCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function readSessionRole(req: Request): Role | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;

  try {
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const expected = Buffer.from(signPayload(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }
    const [role, expiry, trailing] = payload.split(".");
    if (
      trailing !== undefined ||
      (role !== "admin" && role !== "worker") ||
      !expiry ||
      Number(expiry) <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return role;
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, role: Role): void {
  // Раздельный деплой (статика и API на разных доменах) требует SameSite=None:
  // *.onrender.com входит в Public Suffix List, поэтому поддомены фронтенда и
  // бэкенда браузер считает разными сайтами и Strict-cookie не отправил бы.
  // SameSite=None всегда требует Secure (HTTPS) — на Render он есть.
  const crossSite = Boolean(process.env.CORS_ORIGIN?.trim());
  const secure =
    process.env.NODE_ENV === "production" ||
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.REPLIT_DEV_DOMAIN !== undefined ||
    crossSite;
  const sameSite = crossSite ? "None" : "Strict";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(role))}; Path=/api; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`,
  );
}

function requireRole(req: Request, res: Response): Role | null {
  const role = readSessionRole(req);
  if (!role) {
    res.status(401).json({ error: "Требуется вход по PIN-коду" });
    return null;
  }
  return role;
}

const initialState: PosState = {
  menu: MENU_DEFINITIONS.map((item) => ({ ...item, enabled: item.id !== "barbie" })),
  employees: DEFAULT_EMPLOYEES,
  permissions: {
    menuItemIds: MENU_DEFINITIONS.map((item) => item.id),
    seeRevenue: false,
    useDiscounts: true,
    addInventory: true,
    editPastInventory: false,
    editPastShifts: false,
  },
  inventory: [
    { id: "coal", name: "Уголь кокосовый", category: "coal", brand: "", packageGrams: 1000, stock: 10, unit: "кг" },
    { id: "tobacco-musthave", name: "Табак MustHave", category: "tobacco", brand: "MustHave", packageGrams: 125, stock: 2500, unit: "г" },
    { id: "tobacco-darkside", name: "Табак Darkside", category: "tobacco", brand: "Darkside", packageGrams: 100, stock: 2000, unit: "г" },
    { id: "tobacco-blackburn", name: "Табак BlackBurn", category: "tobacco", brand: "BlackBurn", packageGrams: 100, stock: 1800, unit: "г" },
  ],
  containers: [
    { id: "plastic-45", name: "Пластиковый контейнер 45 г", tareGrams: 45 },
    { id: "glass-120", name: "Стеклянная банка 120 г", tareGrams: 120 },
  ],
  shifts: [],
  amidAdjustments: [],
  calculationRules: DEFAULT_CALCULATION_RULES,
  usageSettings: { ...DEFAULT_USAGE_SETTINGS },
  usageRules: [],
  usageLog: [],
  coalOpeningKg: 10,
  updatedAt: new Date().toISOString(),
};

type LegacyState = {
  shifts?: Array<{ id?: unknown; date?: unknown; createdAt?: unknown; amidExtra?: unknown }>;
  amidAdjustments?: unknown;
};

/**
 * Старые состояния хранили доплату Амиду прямо в смене (`shift.amidExtra`).
 * Теперь это изолированная операция `amidAdjustments`, поэтому при чтении
 * переносим суммы в корректировки: Zod-схема неизвестные ключи отбрасывает,
 * и без миграции данные молча потерялись бы.
 */
function migrateLegacyAmidExtra(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const state = raw as LegacyState;
  if (!Array.isArray(state.shifts)) return raw;
  const hasLegacy = state.shifts.some(
    (shift) => Math.floor(Number(shift?.amidExtra ?? 0)) > 0,
  );
  if (!hasLegacy) return raw;
  const adjustments: unknown[] = Array.isArray(state.amidAdjustments)
    ? [...state.amidAdjustments]
    : [];
  const shifts = state.shifts.map((shift) => {
    const amount = Math.floor(Number(shift?.amidExtra ?? 0));
    if (amount <= 0) return shift;
    adjustments.push({
      id: `legacy-${typeof shift.id === "string" ? shift.id : adjustments.length}`,
      date: typeof shift.date === "string" ? shift.date : "",
      amount,
      comment: "Перенесено из поля «Амиду дополнительно» старой смены",
      createdAt: typeof shift.createdAt === "string" ? shift.createdAt : new Date().toISOString(),
    });
    const { amidExtra: _legacy, ...rest } = shift;
    return rest;
  });
  return { ...state, shifts, amidAdjustments: adjustments };
}

async function getOrCreateState(): Promise<PosState> {
  // Инициализация pos_rules при первом запуске
  await ensurePosRulesInitialized();

  const rows = await db.select().from(posStateTable).limit(1);
  if (rows[0]) {
    const parsed = GetPosStateResponse.parse(migrateLegacyAmidExtra(rows[0].state));
    return {
      ...parsed,
      amidAdjustments: parsed.amidAdjustments ?? [],
      calculationRules: parsed.calculationRules ?? DEFAULT_CALCULATION_RULES,
      usageSettings: parsed.usageSettings ?? { ...DEFAULT_USAGE_SETTINGS },
      usageRules: parsed.usageRules ?? [],
      usageLog: parsed.usageLog ?? [],
      employees: parsed.employees?.length ? parsed.employees : DEFAULT_EMPLOYEES,
    };
  }

  await db
    .insert(posStateTable)
    .values({ id: 1, state: initialState as Record<string, unknown> })
    .onConflictDoNothing();
  const created = await db.select().from(posStateTable).limit(1);
  if (!created[0]) throw new Error("Unable to initialize POS state");
  const parsed = GetPosStateResponse.parse(migrateLegacyAmidExtra(created[0].state));
  return {
    ...parsed,
    amidAdjustments: parsed.amidAdjustments ?? [],
    calculationRules: parsed.calculationRules ?? DEFAULT_CALCULATION_RULES,
    usageSettings: parsed.usageSettings ?? { ...DEFAULT_USAGE_SETTINGS },
    usageRules: parsed.usageRules ?? [],
    usageLog: parsed.usageLog ?? [],
    employees: parsed.employees?.length ? parsed.employees : DEFAULT_EMPLOYEES,
  };
}

/** Инициализирует дефолтные правила в таблице pos_rules, если она пуста. */
async function ensurePosRulesInitialized(): Promise<void> {
  const existing = await db.select().from(posRulesTable).limit(1);
  if (existing.length === 0) {
    // Получаем инвентарь для привязки правил к конкретным позициям
    const inventory = await db.select().from(inventoryTable);
    const coalItem = inventory.find((item) =>
      item.category?.toLowerCase().includes("coal") ||
      item.category?.toLowerCase().includes("уголь")
    );
    const tobaccoItem = inventory.find((item) =>
      item.category?.toLowerCase().includes("tobacco") ||
      item.category?.toLowerCase().includes("табак")
    );

    // Если инвентарь пуст, создаём правила без inventoryId (будут привязаны позже)
    const rulesToInsert = DEFAULT_POS_RULES.map((rule, index) => ({
      ...rule,
      inventoryId: rule.targetMaterial === "coal" ? coalItem?.id ?? 1 : tobaccoItem?.id ?? 1,
    }));

    await db.insert(posRulesTable).values(rulesToInsert);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

type UsageRule = {
  id: string;
  name: string;
  inventoryId: string;
  amount: number;
  operation: "sale" | "rebuild";
  menuItemId?: string | null;
  enabled: boolean;
};

/** Отбрасывает структурно негодные правила из старых данных. */
function resolveUsageRules(rules?: UsageRule[] | null): UsageRule[] {
  return (rules ?? []).filter(
    (rule) =>
      rule &&
      typeof rule.id === "string" &&
      rule.id &&
      typeof rule.name === "string" &&
      typeof rule.inventoryId === "string" &&
      Number.isFinite(Number(rule.amount)) &&
      Number(rule.amount) >= 0 &&
      (rule.operation === "sale" || rule.operation === "rebuild"),
  );
}

/** Каноническая категория склада (та же логика, что у клиента). */
function canonicalCategory(value: string): "coal" | "tobacco" | "consumables" | "other" {
  const category = value.trim().toLocaleLowerCase("ru-RU");
  if (category === "coal" || category === "уголь") return "coal";
  if (category === "tobacco" || category === "табак") return "tobacco";
  if (category === "consumables" || category === "расходники") return "consumables";
  return "other";
}

type UsageSource = { ruleId: string; ruleName: string; amount: number; unit: string };
type UsageShiftLike = {
  lines: Array<{ menuItemId: string; tobaccoGrams: number }>;
  rebuilds?: number | null;
};

function usageRuleHits(rule: UsageRule, shift: UsageShiftLike): number {
  if (rule.operation === "rebuild") return Math.max(0, Math.floor(shift.rebuilds ?? 0));
  if (!rule.menuItemId) return shift.lines.length;
  return shift.lines.filter((line) => line.menuItemId === rule.menuItemId).length;
}

/**
 * Суммарный расход смены: сканируются все активные правила — базовые
 * коэффициенты (`usageSettings`) и правила администратора (`usageRules`).
 * Дублирует `evalShiftUsage` из pos-rules.ts (сервер не зависит от клиента).
 */
function evalShiftUsage(
  shift: UsageShiftLike,
  inventory: PosState["inventory"],
  settings: UsageSettings,
  rules: UsageRule[],
): { byCategory: Record<string, number>; coalKg: number; tobaccoGrams: number; sources: UsageSource[] } {
  const rebuilds = Math.max(0, Math.floor(shift.rebuilds ?? 0));
  const lines = shift.lines ?? [];
  const byCategory: Record<string, number> = {};
  const sources: UsageSource[] = [];
  const add = (category: string, amount: number) => {
    if (amount <= 0) return;
    byCategory[category] = (byCategory[category] ?? 0) + amount;
  };

  const coalHookah = lines.length * settings.coalKgPerHookah;
  const coalRebuild = rebuilds * settings.coalKgPerRebuild;
  add("coal", coalHookah + coalRebuild);
  if (coalHookah > 0) {
    sources.push({ ruleId: "base-coal-hookah", ruleName: "Уголь на кальян", amount: coalHookah, unit: "кг" });
  }
  if (coalRebuild > 0) {
    sources.push({ ruleId: "base-coal-rebuild", ruleName: "Уголь на перезабив", amount: coalRebuild, unit: "кг" });
  }

  const bowlGrams = lines.reduce((sum, line) => sum + (Number(line.tobaccoGrams) || 0), 0);
  const tobaccoRebuild = rebuilds * settings.tobaccoGramsPerRebuild;
  add("tobacco", bowlGrams + tobaccoRebuild);
  if (bowlGrams > 0) {
    sources.push({ ruleId: "base-tobacco-bowl", ruleName: "Норма чаши", amount: bowlGrams, unit: "г" });
  }
  if (tobaccoRebuild > 0) {
    sources.push({ ruleId: "base-tobacco-rebuild", ruleName: "Табак на перезабив", amount: tobaccoRebuild, unit: "г" });
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const item = inventory.find((entry) => entry.id === rule.inventoryId);
    if (!item) continue;
    const amount = Math.max(0, rule.amount) * usageRuleHits(rule, shift);
    if (amount <= 0) continue;
    add(canonicalCategory(item.category), amount);
    sources.push({ ruleId: rule.id, ruleName: rule.name.trim() || "Правило", amount, unit: item.unit });
  }

  return {
    byCategory,
    coalKg: byCategory.coal ?? 0,
    tobaccoGrams: byCategory.tobacco ?? 0,
    sources,
  };
}

/** Суммарный расход всех смен по категориям склада (для валидации остатков). */
function usageDemandByCategory(state: PosState): Record<string, number> {
  const settings = resolveUsageSettings(state.usageSettings);
  const rules = resolveUsageRules(state.usageRules);
  const total: Record<string, number> = {};
  for (const shift of state.shifts) {
    const demand = evalShiftUsage(shift, state.inventory, settings, rules);
    for (const [category, amount] of Object.entries(demand.byCategory)) {
      total[category] = (total[category] ?? 0) + amount;
    }
  }
  return total;
}

/**
 * Раскладка расхода по позициям склада: база — по позициям категории в
 * порядке каталога, правило — прежде всего свою привязанную позицию.
 * Дублирует `allocateShiftUsage` из pos-rules.ts.
 */
function allocateShiftUsage(
  shift: UsageShiftLike,
  inventory: PosState["inventory"],
  settings: UsageSettings,
  rules: UsageRule[],
): { byItem: Record<string, number>; short: boolean } {
  const rebuilds = Math.max(0, Math.floor(shift.rebuilds ?? 0));
  const lines = shift.lines ?? [];
  type Chunk = { category: string; targetId?: string; amount: number };
  const chunks: Chunk[] = [];
  const coalAmount = lines.length * settings.coalKgPerHookah + rebuilds * settings.coalKgPerRebuild;
  if (coalAmount > 0) chunks.push({ category: "coal", amount: coalAmount });
  const bowlGrams = lines.reduce((sum, line) => sum + (Number(line.tobaccoGrams) || 0), 0);
  const tobaccoAmount = bowlGrams + rebuilds * settings.tobaccoGramsPerRebuild;
  if (tobaccoAmount > 0) chunks.push({ category: "tobacco", amount: tobaccoAmount });
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const item = inventory.find((entry) => entry.id === rule.inventoryId);
    if (!item) continue;
    const amount = Math.max(0, rule.amount) * usageRuleHits(rule, shift);
    if (amount <= 0) continue;
    chunks.push({ category: canonicalCategory(item.category), targetId: item.id, amount });
  }

  const capacity = new Map(
    inventory.map((item) => [item.id, Math.max(0, Number(item.stock) || 0)]),
  );
  const byItem: Record<string, number> = {};
  let short = false;
  const takeFrom = (itemId: string, amount: number): number => {
    const cap = capacity.get(itemId) ?? 0;
    const take = Math.min(cap, amount);
    if (take > 0) {
      capacity.set(itemId, cap - take);
      byItem[itemId] = (byItem[itemId] ?? 0) + take;
    }
    return amount - take;
  };

  for (const chunk of chunks) {
    let remaining = chunk.amount;
    if (chunk.targetId && capacity.has(chunk.targetId)) {
      remaining = takeFrom(chunk.targetId, remaining);
    }
    for (const item of inventory) {
      if (remaining <= 1e-9) break;
      if (item.id === chunk.targetId) continue;
      if (canonicalCategory(item.category) !== chunk.category) continue;
      remaining = takeFrom(item.id, remaining);
    }
    if (remaining > 1e-9) short = true;
  }

  return { byItem, short };
}

type UsageLogEntry = NonNullable<PosState["usageLog"]>[number];

/** Формат числа в формуле списания: без хвостовых нулей (0.125 → «0.125»). */
function formatAmount(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Сборка записи журнала списаний: суммы по категориям, формула с
 * коэффициентами и правилами, источники (каким правилом списано) и раскладка
 * расхода по складским позициям.
 */
function buildUsageLogEntry(
  shift: PosState["shifts"][number],
  inventory: PosState["inventory"],
  settings: UsageSettings,
  rules: UsageRule[],
): UsageLogEntry {
  const rebuilds = Math.max(0, Math.floor(shift.rebuilds ?? 0));
  const hookahCount = shift.lines.length;
  const demand = evalShiftUsage(shift, inventory, settings, rules);
  const allocation = allocateShiftUsage(shift, inventory, settings, rules);

  const bowlGrams = shift.lines.reduce((sum, line) => sum + line.tobaccoGrams, 0);
  const coalParts: string[] = [];
  if (hookahCount > 0) {
    coalParts.push(`${hookahCount} × ${formatAmount(settings.coalKgPerHookah)} кг`);
  }
  if (rebuilds > 0) {
    coalParts.push(`${rebuilds} × ${formatAmount(settings.coalKgPerRebuild)} кг`);
  }
  const tobaccoParts: string[] = [];
  if (bowlGrams > 0) tobaccoParts.push(`${formatAmount(bowlGrams)} г`);
  if (rebuilds > 0) {
    tobaccoParts.push(`${rebuilds} × ${formatAmount(settings.tobaccoGramsPerRebuild)} г`);
  }
  // Правила администратора — строкой формулы со своим названием.
  let coalFormulaTotal = 0;
  let tobaccoFormulaTotal = 0;
  for (const source of demand.sources) {
    if (source.ruleId.startsWith("base-")) continue;
    if (source.unit === "кг") {
      coalParts.push(`«${source.ruleName}» ${formatAmount(source.amount)} кг`);
      coalFormulaTotal += source.amount;
    } else if (source.unit === "г") {
      tobaccoParts.push(`«${source.ruleName}» ${formatAmount(source.amount)} г`);
      tobaccoFormulaTotal += source.amount;
    }
  }
  coalFormulaTotal +=
    hookahCount * settings.coalKgPerHookah + rebuilds * settings.coalKgPerRebuild;
  tobaccoFormulaTotal += bowlGrams + rebuilds * settings.tobaccoGramsPerRebuild;

  const items = Object.entries(allocation.byItem).flatMap(
    ([inventoryId, amount]) => {
      const item = inventory.find((entry) => entry.id === inventoryId);
      if (!item || amount <= 0) return [];
      const category = canonicalCategory(item.category);
      return [{
        inventoryId,
        name: item.name,
        coalKg: category === "coal" ? amount : 0,
        tobaccoGrams: category === "tobacco" ? amount : 0,
        amount,
        unit: item.unit,
      }];
    },
  );

  return {
    id: `usage-${shift.id}`,
    shiftId: shift.id,
    date: shift.date,
    hookahCount,
    rebuildCount: rebuilds,
    coalKg: demand.coalKg,
    tobaccoGrams: demand.tobaccoGrams,
    coalFormula: `${coalParts.length ? coalParts.join(" + ") : "0"} = ${formatAmount(coalFormulaTotal)} кг`,
    tobaccoFormula: `${tobaccoParts.length ? tobaccoParts.join(" + ") : "0"} = ${formatAmount(tobaccoFormulaTotal)} г`,
    sources: demand.sources,
    items,
    createdAt: shift.createdAt,
  };
}

/**
 * Журнал списаний пересчитывается сервером при каждом сохранении:
 * - неизменённые смены сохраняют запись с формулой, с которой были списаны;
 * - новая смена получает новую запись (расход раскладывается по складским
 *   позициям в порядке каталога — как списывает клиент);
 * - изменённая смена переписывается с новыми коэффициентами, удалённая —
 *   выпадает из журнала.
 * Клиенту журнал не доверяется: значение заменяется на рассчитанное.
 */
function rebuildUsageLog(current: PosState, next: PosState): UsageLogEntry[] {
  const settings = resolveUsageSettings(next.usageSettings);
  const rules = resolveUsageRules(next.usageRules);
  const previousEntries = new Map(
    (current.usageLog ?? []).map((entry) => [entry.shiftId, entry]),
  );
  const previousShifts = new Map(current.shifts.map((shift) => [shift.id, shift]));
  const entries: UsageLogEntry[] = [];
  for (const shift of next.shifts) {
    const previousShift = previousShifts.get(shift.id);
    const previousEntry = previousEntries.get(shift.id);
    if (
      previousEntry &&
      previousShift &&
      stableJson(previousShift) === stableJson(shift)
    ) {
      entries.push(previousEntry);
      continue;
    }
    entries.push(buildUsageLogEntry(shift, current.inventory, settings, rules));
  }
  return entries;
}

function getShiftMembers(master: string): string[] {
  return master.split(/[+/]/).map((name) => name.trim()).filter(Boolean);
}

function validMaster(master: string, employees: NonNullable<PosState["employees"]>): boolean {
  const members = getShiftMembers(master);
  const employeeNames = new Set(employees.map((employee) => employee.name));
  return members.length > 0 && new Set(members).size === members.length && members.every((name) => employeeNames.has(name));
}

function calculateShiftPayroll(
  shift: PosState["shifts"][number],
  menu: PosState["menu"],
  employees: NonNullable<PosState["employees"]>,
): number {
  const totalHookahs = shift.lines.length;
  const members = getShiftMembers(shift.master);
  const baseSalary = members.reduce((sum, name) => {
    const employee = employees.find((entry) => entry.name === name);
    return sum + (totalHookahs > 30 ? employee?.highVolumeSalary ?? 0 : employee?.baseSalary ?? 0);
  }, 0);
  const fixedBase = members.length === 1 && shift.fixedSalary !== null && shift.fixedSalary !== undefined
    ? shift.fixedSalary
    : baseSalary;
  const bonuses = shift.lines.reduce((sum, line) => {
    const item = menu.find((entry) => entry.id === line.menuItemId);
    return sum + (item?.salaryBonus ?? MENU_DEFINITIONS.find((entry) => entry.id === line.menuItemId)?.salaryBonus ?? 0);
  }, 0);

  // Joint shifts add the whole bonus pool on top of both base salaries, the
  // members split the resulting pot evenly (kept in sync with pos-rules.ts).
  return fixedBase + bonuses + shift.helpersPay;
}

function applyShiftInventory(state: PosState, shift: PosState["shifts"][number]): PosState {
  // Списание по всем активным правилам: базовые коэффициенты + правила
  // администратора, раскладка по позициям — как у клиента.
  const settings = resolveUsageSettings(state.usageSettings);
  const rules = resolveUsageRules(state.usageRules);
  const allocation = allocateShiftUsage(shift, state.inventory, settings, rules);
  return {
    ...state,
    inventory: state.inventory.map((item) => {
      const used = allocation.byItem[item.id];
      return used ? { ...item, stock: Math.max(0, item.stock - used) } : item;
    }),
  };
}

function categoryIs(itemCategory: string, category: "coal" | "tobacco"): boolean {
  const value = itemCategory.trim().toLocaleLowerCase("ru-RU");
  return category === "coal"
    ? value === "coal" || value === "уголь"
    : value === "tobacco" || value === "табак";
}

function validateWorkerUpdate(
  current: PosState,
  next: PosState,
  permissions: PosState["permissions"],
): string | null {
  if (
    stableJson(current.menu) !== stableJson(next.menu) ||
    stableJson(current.employees ?? DEFAULT_EMPLOYEES) !== stableJson(next.employees ?? DEFAULT_EMPLOYEES) ||
    stableJson(current.permissions) !== stableJson(next.permissions) ||
    stableJson(current.containers) !== stableJson(next.containers) ||
    // Правила расчёта — настройки владельца: работник их не правит.
    stableJson(current.calculationRules ?? []) !== stableJson(next.calculationRules ?? []) ||
    // Коэффициенты и конструктор правил списания — тоже настройки владельца.
    stableJson(current.usageSettings ?? null) !== stableJson(next.usageSettings ?? null) ||
    stableJson(current.usageRules ?? []) !== stableJson(next.usageRules ?? []) ||
    (!permissions.editPastInventory &&
      current.coalOpeningKg !== next.coalOpeningKg)
  ) {
    return "Работник не может менять настройки, меню, правила расчёта, правила списания и начальные остатки";
  }

  const existingShiftsUnchanged =
    next.shifts.length >= current.shifts.length &&
    current.shifts.every(
      (shift) =>
        next.shifts.some(
          (candidate) =>
            candidate.id === shift.id && stableJson(shift) === stableJson(candidate),
        ),
    );
  const permittedPastEdits =
    permissions.editPastShifts &&
    next.shifts.every((shift) => current.shifts.some((old) => old.id === shift.id));
  if (
    !existingShiftsUnchanged &&
    !permittedPastEdits
  ) {
    return "Нет разрешения на редактирование прошлых смен";
  }
  if (
    existingShiftsUnchanged &&
    next.shifts.length > current.shifts.length + 1
  ) {
    return "За один раз можно добавить только одну смену";
  }

  const today = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const newShifts = next.shifts.filter(
    (shift) => !current.shifts.some((old) => old.id === shift.id),
  );
  if (
    !permissions.editPastShifts &&
    newShifts.some((shift) => shift.date !== today)
  ) {
    return "Нет разрешения на сохранение смены задним числом";
  }

  for (const shift of newShifts) {
    if (!validMaster(shift.master, current.employees ?? DEFAULT_EMPLOYEES) || shift.lines.length === 0) {
      return "Проверьте мастера и позиции смены";
    }
    for (const line of shift.lines) {
      const menuItem = current.menu.find((item) => item.id === line.menuItemId);
      if (
        !menuItem ||
        !menuItem.enabled ||
        !permissions.menuItemIds.includes(line.menuItemId)
      ) {
        return "Эта позиция меню недоступна работнику";
      }
      if (
        line.menuItemName !== menuItem.name ||
        line.unitPrice !== menuItem.price ||
        line.tobaccoGrams !== menuItem.tobaccoGrams
      ) {
        return "Цена и расход табака должны соответствовать меню";
      }
      if (line.discount !== 0 && !permissions.useDiscounts) {
        return "Нет разрешения на применение скидок";
      }
      if (line.discount !== 0 && !line.reason.trim()) {
        return "Для применения скидки укажите причину";
      }
    }
  }

  const currentInventory = new Map(current.inventory.map((item) => [item.id, item]));
  if (next.inventory.length !== current.inventory.length) {
    return "Работник не может менять каталог товаров";
  }
  for (const item of next.inventory) {
    const old = currentInventory.get(item.id);
    if (!old) return "Работник не может менять каталог товаров";
    const { stock: previousStock, ...oldDetails } = old;
    const { stock, ...newDetails } = item;
    if (stableJson(oldDetails) !== stableJson(newDetails)) {
      return "Работник не может менять каталог товаров";
    }
    if (!Number.isFinite(stock) || stock < 0) return "Остаток не может быть отрицательным";
  }

  const currentUsage = usageDemandByCategory(current);
  const nextUsage = usageDemandByCategory(next);
  const categories = new Set<string>([
    ...Object.keys(currentUsage),
    ...Object.keys(nextUsage),
    ...current.inventory.map((item) => canonicalCategory(item.category)),
    ...next.inventory.map((item) => canonicalCategory(item.category)),
  ]);
  const categoryLabels: Record<string, string> = {
    coal: "уголь",
    tobacco: "табак",
    consumables: "расходники",
    other: "прочее",
  };
  const stockDelta = (category: string) =>
    next.inventory
      .filter((item) => canonicalCategory(item.category) === category)
      .reduce((sum, item) => sum + item.stock, 0) -
    current.inventory
      .filter((item) => canonicalCategory(item.category) === category)
      .reduce((sum, item) => sum + item.stock, 0);
  const positiveStockChange = (category: string) =>
    next.inventory
      .filter((item) => canonicalCategory(item.category) === category)
      .reduce((sum, item) => {
        const previous = currentInventory.get(item.id);
        return sum + Math.max(0, item.stock - (previous?.stock ?? 0));
      }, 0);
  // Категории с автоматическим расходом: сверяются только суммарно.
  const usedCategories = new Set<string>();
  for (const [category, amount] of Object.entries(currentUsage)) {
    if (amount > 0.0001) usedCategories.add(category);
  }
  for (const [category, amount] of Object.entries(nextUsage)) {
    if (amount > 0.0001) usedCategories.add(category);
  }
  let receipts = 0;
  for (const category of categories) {
    const delta = stockDelta(category);
    const expected = -((nextUsage[category] ?? 0) - (currentUsage[category] ?? 0));
    const categoryReceipts = Math.max(
      0,
      positiveStockChange(category) - Math.max(0, expected),
    );
    receipts += categoryReceipts;
    if (
      !permissions.editPastInventory &&
      Math.abs(delta - expected - categoryReceipts) > 0.0001
    ) {
      return `Остаток категории «${categoryLabels[category] ?? category}» должен учитывать автоматический расход и приёмку`;
    }
  }
  if (
    receipts > 0.0001 &&
    !permissions.addInventory &&
    !permissions.editPastInventory
  ) {
    return "Нет разрешения на добавление товаров в инвентарь";
  }
  // Позиции категорий без автоматического расхода работник правит только по
  // праву переучёта — ручное уменьшение без разрешения отклоняется.
  for (const item of next.inventory) {
    if (usedCategories.has(canonicalCategory(item.category))) continue;
    const before = currentInventory.get(item.id)!;
    if (item.stock < before.stock && !permissions.editPastInventory) {
      return "Работник не может вручную корректировать этот остаток";
    }
    if (
      item.stock > before.stock &&
      !permissions.addInventory &&
      !permissions.editPastInventory
    ) {
      return "Нет разрешения на добавление товаров в инвентарь";
    }
  }
  return null;
}

router.get("/pos/session", (req, res) => {
  const role = readSessionRole(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: role !== null, role });
});

// Защита от перебора четырёхзначного PIN: блокируем IP после серии неудач.
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;
const loginFailures = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();

function checkLoginGate(ip: string): { blocked: boolean; retryAfterSeconds: number } {
  const entry = loginFailures.get(ip);
  if (!entry) return { blocked: false, retryAfterSeconds: 0 };
  const now = Date.now();
  if (entry.blockedUntil > now) {
    return { blocked: true, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

function registerLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
  }
}

router.post("/pos/login", (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const gate = checkLoginGate(ip);
  if (gate.blocked) {
    res.setHeader("Retry-After", String(gate.retryAfterSeconds));
    res.status(429).json({ error: "Слишком много попыток входа. Попробуйте позже." });
    return;
  }

  const parsed = LoginPosBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Введите PIN-код из четырёх цифр" });
    return;
  }
  const role: Role | null =
    parsed.data.pin === "0000"
      ? "admin"
      : parsed.data.pin === "1111"
        ? "worker"
        : null;
  if (!role) {
    registerLoginFailure(ip);
    res.status(401).json({ error: "Неверный PIN-код" });
    return;
  }
  loginFailures.delete(ip);
  setSessionCookie(res, role);
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: true, role });
});

router.delete("/pos/session", (_req, res) => {
  // SameSite/Secure при удалении не влияют на идентичность cookie (имя + Path),
  // но указываем те же значения, что и при выставлении, ради консистентности.
  const sameSite = Boolean(process.env.CORS_ORIGIN?.trim()) ? "None" : "Strict";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=${sameSite}; Max-Age=0`,
  );
  res.json({ authenticated: false, role: null });
});

router.get("/pos/state", async (req, res) => {
  if (!requireRole(req, res)) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getOrCreateState());
  } catch (error) {
    req.log.error({ err: error }, "Failed to load POS state");
    res.status(500).json({ error: "Не удалось загрузить данные POS" });
  }
});

router.get("/pos/settings", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;

  try {
    const state = await getOrCreateState();
    const payload = {
      role,
      permissions: state.permissions,
      menu: state.menu,
      employees: state.employees ?? DEFAULT_EMPLOYEES,
      updatedAt: state.updatedAt,
    };
    res.json(payload);
  } catch (error) {
    req.log.error({ err: error }, "Failed to load POS settings");
    res.status(500).json({ error: "Не удалось загрузить настройки POS" });
  }
});

router.post("/pos/settings", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  if (role !== "admin") {
    res.status(403).json({ error: "Только администратор может изменять настройки" });
    return;
  }

  try {
    const current = await getOrCreateState();
    const next = {
      ...current,
      permissions: { ...current.permissions, ...req.body.permissions },
      menu: Array.isArray(req.body.menu) ? req.body.menu : current.menu,
      employees: Array.isArray(req.body.employees) ? req.body.employees : current.employees,
      updatedAt: new Date().toISOString(),
    };

    await db
      .update(posStateTable)
      .set({ state: next as Record<string, unknown>, updatedAt: new Date(next.updatedAt) })
      .where(eq(posStateTable.id, 1));

    res.json(next);
  } catch (error) {
    req.log.error({ err: error }, "Failed to save POS settings");
    res.status(500).json({ error: "Не удалось сохранить настройки POS" });
  }
});

/** Получение списка правил списания (pos_rules). */
router.get("/pos/rules", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;

  try {
    const rules = await db
      .select()
      .from(posRulesTable)
      .orderBy(asc(posRulesTable.sortOrder), asc(posRulesTable.id));
    res.json(rules);
  } catch (error) {
    req.log.error({ err: error }, "Failed to load pos rules");
    res.status(500).json({ error: "Не удалось загрузить правила списания" });
  }
});

/** Создание нового правила списания. */
router.post("/pos/rules", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  if (role !== "admin") {
    res.status(403).json({ error: "Только администратор может создавать правила списания" });
    return;
  }

  try {
    const { name, inventoryId, amount, operation, menuItemId, enabled, sortOrder } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: "Название правила обязательно" });
      return;
    }
    if (!inventoryId) {
      res.status(400).json({ error: "Позиция склада обязательна" });
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      res.status(400).json({ error: "Расход должен быть числом не меньше 0" });
      return;
    }
    if (operation !== "sale" && operation !== "rebuild") {
      res.status(400).json({ error: "Тип операции должен быть 'sale' или 'rebuild'" });
      return;
    }

    const maxSort = await db
      .select({ max: sql`max(${posRulesTable.sortOrder})` })
      .from(posRulesTable);
    const nextSortOrder = sortOrder ?? (Number(maxSort[0]?.max) + 1 || 1);

    const inserted = await db
      .insert(posRulesTable)
      .values({
        name: name.trim(),
        inventoryId: Number(inventoryId),
        amount: numericAmount.toFixed(3),
        operation,
        menuItemId: operation === "sale" ? (menuItemId || null) : null,
        enabled: enabled ?? true,
        sortOrder: nextSortOrder,
      })
      .returning();

    res.status(201).json(inserted[0]);
  } catch (error) {
    req.log.error({ err: error }, "Failed to create pos rule");
    res.status(500).json({ error: "Не удалось создать правило списания" });
  }
});

/** Обновление правила списания. */
router.put("/pos/rules/:id", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  if (role !== "admin") {
    res.status(403).json({ error: "Только администратор может изменять правила списания" });
    return;
  }

  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Неверный ID правила" });
      return;
    }

    const { name, inventoryId, amount, operation, menuItemId, enabled, sortOrder } = req.body;

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (inventoryId !== undefined) updateData.inventoryId = Number(inventoryId);
    if (amount !== undefined) {
      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount < 0) {
        res.status(400).json({ error: "Расход должен быть числом не меньше 0" });
        return;
      }
      updateData.amount = numericAmount.toFixed(3);
    }
    if (operation !== undefined) {
      if (operation !== "sale" && operation !== "rebuild") {
        res.status(400).json({ error: "Тип операции должен быть 'sale' или 'rebuild'" });
        return;
      }
      updateData.operation = operation;
      updateData.menuItemId = operation === "sale" ? (menuItemId || null) : null;
    } else if (menuItemId !== undefined) {
      updateData.menuItemId = menuItemId || null;
    }
    if (enabled !== undefined) updateData.enabled = enabled;
    if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder);

    updateData.updatedAt = new Date();

    const updated = await db
      .update(posRulesTable)
      .set(updateData)
      .where(eq(posRulesTable.id, id))
      .returning();

    if (!updated[0]) {
      res.status(404).json({ error: "Правило не найдено" });
      return;
    }

    res.json(updated[0]);
  } catch (error) {
    req.log.error({ err: error }, "Failed to update pos rule");
    res.status(500).json({ error: "Не удалось обновить правило списания" });
  }
});

/** Удаление правила списания. */
router.delete("/pos/rules/:id", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  if (role !== "admin") {
    res.status(403).json({ error: "Только администратор может удалять правила списания" });
    return;
  }

  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Неверный ID правила" });
      return;
    }

    await db.delete(posRulesTable).where(eq(posRulesTable.id, id));
    res.status(204).send();
  } catch (error) {
    req.log.error({ err: error }, "Failed to delete pos rule");
    res.status(500).json({ error: "Не удалось удалить правило списания" });
  }
});

router.post("/pos/shifts", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;

  try {
    const current = await getOrCreateState();
    const shiftPayload = req.body.shift ?? req.body;
    const shift = {
      ...shiftPayload,
      id: shiftPayload.id ?? `${Date.now()}`,
      createdAt: new Date().toISOString(),
    };

    const shiftLines = Array.isArray(shift.lines)
      ? (shift.lines as Array<{ discount: number; menuItemId: string }>)
      : [];

    if (!validMaster(shift.master, current.employees ?? DEFAULT_EMPLOYEES) || shiftLines.length === 0) {
      res.status(400).json({ error: "Проверьте мастера, дату и состав смены" });
      return;
    }

    const next = applyShiftInventory(
      {
        ...current,
        shifts: [shift, ...current.shifts],
      },
      shift,
    );
    // Журнал списаний ведёт сервер: новая смена сразу получает запись с
    // формулой, источниками-правилами и раскладкой по складу.
    next.usageLog = rebuildUsageLog(current, next);

    if (role === "worker") {
      const permissions = current.permissions;
      if (!permissions.useDiscounts && shiftLines.some((line) => line.discount > 0)) {
        res.status(403).json({ error: "У сотрудника нет прав на скидки" });
        return;
      }
      const forbidden = shiftLines.filter(
        (line) => !permissions.menuItemIds.includes(line.menuItemId),
      );
      if (forbidden.length > 0) {
        res.status(403).json({ error: "Сотрудник не имеет доступа к одной из позиций" });
        return;
      }
    }

    const finalState = {
      ...next,
      updatedAt: new Date().toISOString(),
    };

    await db
      .update(posStateTable)
      .set({ state: finalState as Record<string, unknown>, updatedAt: new Date(finalState.updatedAt) })
      .where(eq(posStateTable.id, 1));

    res.status(201).json({
      shift,
      state: finalState,
      payroll: calculateShiftPayroll(shift, finalState.menu, finalState.employees ?? DEFAULT_EMPLOYEES),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to save shift");
    res.status(500).json({ error: "Не удалось сохранить смену" });
  }
});

type SchemaIssue = { path: (string | number)[]; message: string };

// Поля меню, которые чаще всего мешают сохранению: правило и подсказка.
const MENU_FIELD_RULES: Record<string, string> = {
  id: "укажите идентификатор позиции",
  name: "укажите название позиции",
  price: "цена — число не меньше 0",
  tobaccoGrams: `табак — целое число от ${MIN_TOBACCO_GRAMS} до ${MAX_TOBACCO_GRAMS} г`,
  salaryBonus: "доплата — число не меньше 0",
};

/**
 * Ошибки Zod превращаем в понятные строки. Состояние принимается целиком,
 * поэтому при отказе нужно сразу показать позицию и поле, которые правят:
 * иначе админ видел общее «неверный формат» и не понимал, что исправить.
 */
function describeStateIssues(
  issues: SchemaIssue[],
  body: { menu?: Array<{ name?: unknown }> } | undefined,
): string[] {
  const menu = Array.isArray(body?.menu) ? body.menu : [];
  return issues.slice(0, 5).map((issue) => {
    const [scope, index, field] = issue.path;
    if (
      scope === "menu" &&
      typeof index === "number" &&
      typeof field === "string" &&
      MENU_FIELD_RULES[field]
    ) {
      const rawName = menu[index]?.name;
      const label =
        typeof rawName === "string" && rawName.trim()
          ? `«${rawName.trim()}»`
          : `позиция №${index + 1}`;
      return `${label}: ${MENU_FIELD_RULES[field]}`;
    }
    return `${issue.path.join(".") || "данные"}: ${issue.message}`;
  });
}

router.put("/pos/state", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  const parsed = SavePosStateBody.safeParse(req.body);
  if (!parsed.success) {
    const details = describeStateIssues(parsed.error.issues, req.body);
    req.log.warn(
      { details, count: parsed.error.issues.length },
      "POS state rejected by schema",
    );
    res.status(400).json({
      error: `Проверьте данные: ${details.join("; ")}`,
      details,
    });
    return;
  }
  try {
    const result = await db.transaction(async (tx: any) => {
      await tx
        .insert(posStateTable)
        .values({ id: 1, state: initialState as Record<string, unknown> })
        .onConflictDoNothing();
      const rows = await tx
        .select()
        .from(posStateTable)
        .where(eq(posStateTable.id, 1))
        .for("update");
      if (!rows[0]) throw new Error("Unable to initialize POS state");
      const current = GetPosStateResponse.parse(migrateLegacyAmidExtra(rows[0].state));

      if (parsed.data.updatedAt !== current.updatedAt) {
        return {
          status: 409 as const,
          error: "Данные уже изменились в другом сеансе. Обновите страницу и повторите действие.",
        };
      }

      const next = {
        ...parsed.data,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt) + 1),
        ).toISOString(),
      };
      // Журнал списаний сервер считает сам: клиент прислал своё значение,
      // но формулой и раскладкой по складу владеет только сервер.
      next.usageLog = rebuildUsageLog(current, next);
      if (role === "worker") {
        const error = validateWorkerUpdate(current, next, current.permissions);
        if (error) return { status: 403 as const, error };
      }

      const saved = GetPosStateResponse.parse(next);
      await tx
        .update(posStateTable)
        .set({
          state: saved as Record<string, unknown>,
          updatedAt: new Date(saved.updatedAt),
        })
        .where(eq(posStateTable.id, 1));
      return { status: 200 as const, saved };
    });
    if (result.status !== 200) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(result.saved);
  } catch (error) {
    req.log.error({ err: error }, "Failed to save POS state");
    res.status(500).json({ error: "Не удалось сохранить данные POS" });
  }
});

export default router;
