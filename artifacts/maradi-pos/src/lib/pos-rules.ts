export type MenuBonusItem = {
  id: string;
  salaryBonus?: number;
};

export type ShiftLineWithBonus = {
  menuItemId: string;
};

export type PayrollEmployee = {
  name: string;
  baseSalary: number;
  highVolumeSalary: number;
};

// Ставки заведения (сверено с таблицей за август-сентябрь 2026):
// Амид 3300 ₽ и 5000 ₽ свыше 30 кальянов, Олег 2800 ₽, Ренат и Максим 2500 ₽.
export const DEFAULT_EMPLOYEE_SALARIES: PayrollEmployee[] = [
  { name: 'Амид', baseSalary: 3300, highVolumeSalary: 5000 },
  { name: 'Олег', baseSalary: 2800, highVolumeSalary: 2800 },
  { name: 'Ренат', baseSalary: 2500, highVolumeSalary: 2500 },
  { name: 'Максим', baseSalary: 2500, highVolumeSalary: 2500 },
  { name: 'Кирилл', baseSalary: 0, highVolumeSalary: 0 },
];

export const DEFAULT_MENU_SALARY_BONUSES: Record<string, number> = {
  classic: 100,
  grapefruit: 150,
  pineapple: 150,
  signature: 500,
};

export function getMenuSalaryBonus(item: MenuBonusItem | null | undefined): number {
  if (!item) return 0;
  const value = Number(item.salaryBonus ?? DEFAULT_MENU_SALARY_BONUSES[item.id] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Границы нормы табака на чашу — те же, что в контракте API (`openapi.yaml`).
 * Вес чаши задаёт владелец заведения: любые целые 1–100 г (раньше было 24–27).
 */
export const MIN_TOBACCO_GRAMS = 1;
export const MAX_TOBACCO_GRAMS = 100;

export type MenuRuleItem = {
  id: string;
  name: string;
  price: number;
  tobaccoGrams: number;
  salaryBonus?: number | null;
};

export type MenuRuleIssue = {
  itemId: string;
  index: number;
  field: 'name' | 'price' | 'tobaccoGrams' | 'salaryBonus';
  message: string;
};

/**
 * Проверка позиций меню перед отправкой состояния на сервер.
 *
 * Сервер валидирует документ целиком (Zod-схема из OpenAPI), поэтому одна
 * позиция с табаком вне 24–27 г или с нечисловой ценой отклоняет сохранение
 * всего состояния — и смены, и склад, и меню остаются прежними. Проверяем
 * здесь, чтобы показать причину до запроса, а не общее «неверный формат».
 */
export function validateMenuItems(items: MenuRuleItem[] = []): MenuRuleIssue[] {
  const issues: MenuRuleIssue[] = [];
  items.forEach((item, index) => {
    const itemId = item?.id ?? `#${index + 1}`;
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name) {
      issues.push({ itemId, index, field: 'name', message: 'укажите название позиции' });
    }

    const price = Number(item?.price);
    if (!Number.isFinite(price) || price < 0) {
      issues.push({ itemId, index, field: 'price', message: 'цена — число не меньше 0' });
    }

    const grams = Number(item?.tobaccoGrams);
    if (!Number.isInteger(grams) || grams < MIN_TOBACCO_GRAMS || grams > MAX_TOBACCO_GRAMS) {
      issues.push({
        itemId,
        index,
        field: 'tobaccoGrams',
        message: `табак — целое число от ${MIN_TOBACCO_GRAMS} до ${MAX_TOBACCO_GRAMS} г`,
      });
    }

    const bonus = item?.salaryBonus;
    if (bonus !== undefined && bonus !== null) {
      const value = Number(bonus);
      if (!Number.isFinite(value) || value < 0) {
        issues.push({ itemId, index, field: 'salaryBonus', message: 'доплата — число не меньше 0' });
      }
    }
  });
  return issues;
}

/** Человекочитаемая строка ошибки позиции: «Вишня»: табак — целое число от 1 до 100 г. */
export function formatMenuIssue(issue: MenuRuleIssue, name?: string | null): string {
  const label = name && name.trim() ? `«${name.trim()}»` : `позиция №${issue.index + 1}`;
  return `${label}: ${issue.message}`;
}

/**
 * Разбор числа из поля ручного ввода: запятая как десятичный разделитель,
 * пустое или нечисловое значение — `emptyValue` (по умолчанию 0).
 */
export function parseNumericInput(raw: string, emptyValue = 0): number {
  const normalized = raw.trim().replace(',', '.');
  if (normalized === '') return emptyValue;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : emptyValue;
}

/** Варианты категории склада для <select> на странице остатков. */
export type InventoryCategory = 'tobacco' | 'coal' | 'consumables' | 'other';

/**
 * Сохранённое значение категории → вариант селекта. В старых данных категория
 * могла лежать как «Табак» или «уголь»: без нормализации <select> не нашёл бы
 * такой вариант среди предложенных и молча показал бы первый в списке.
 */
export function inventoryCategorySelectValue(value: string): InventoryCategory {
  const category = value.trim().toLocaleLowerCase('ru-RU');
  if (category === 'coal' || category === 'уголь') return 'coal';
  if (category === 'tobacco' || category === 'табак') return 'tobacco';
  if (category === 'consumables' || category === 'расходники') return 'consumables';
  return 'other';
}

/** Каноническая единица измерения позиции (та же логика, что в форме создания). */
export function inventoryUnitForCategory(category: string): string {
  return category === 'coal' ? 'кг' : category === 'tobacco' ? 'г' : 'шт.';
}

/**
 * Правило из плашки «Правила расчёта»: название («Уголь») и описание
 * («125 г на кальян + 125 г на перезабивку»). Список динамический — владелец
 * редактирует, добавляет и удаляет правила прямо на странице смены.
 */
export type CalculationRule = {
  id: number;
  name: string;
  rule: string;
};

/** Стартовые правила — те же строки, что раньше были захардкожены в JSX. */
export const DEFAULT_CALCULATION_RULES: CalculationRule[] = [
  { id: 1, name: 'Уголь', rule: '125 г на кальян + 125 г на перезабивку' },
  { id: 2, name: 'Табак', rule: '24–27 г на чашу + 24 г на перезабивку' },
  { id: 3, name: 'Оклад', rule: 'Оклад каждому свой; доплата за позиции делится поровну' },
];

/** id для новой строки: максимум существующих + 1 (пустой список — с единицы). */
export function nextCalculationRuleId(rules: CalculationRule[] = []): number {
  return rules.reduce((max, rule) => Math.max(max, Number(rule?.id) || 0), 0) + 1;
}

/**
 * Проверка перед сохранением: пустое название или описание — отказ, как в
 * форме создания складской позиции (причина понятна до запроса).
 */
export function validateCalculationRules(rules: CalculationRule[] = []): string | null {
  for (const [index, rule] of rules.entries()) {
    if (!rule?.name?.trim()) return `правило №${index + 1}: укажите название`;
    if (!rule?.rule?.trim()) return `правило «${rule.name.trim()}»: укажите описание`;
  }
  return null;
}

/** Участники смены: «Ренат/Амид», «Амид + Олег». */
export const splitShiftMembers = (master: string): string[] =>
  master.split(/[+/]/).map((name) => name.trim()).filter(Boolean);

/** Оклад сотрудника за смену (после 30 кальянов действует повышенная ставка). */
export function getMemberBaseSalary(
  name: string,
  hookahCount: number,
  employees: PayrollEmployee[] = DEFAULT_EMPLOYEE_SALARIES,
): number {
  const employee = employees.find((entry) => entry.name === name);
  if (!employee) return 0;
  return hookahCount > 30 ? employee.highVolumeSalary : employee.baseSalary;
}

/** Процент смены — сумма доплат за позиции меню. */
export function calcMenuBonusPool(lines: ShiftLineWithBonus[], menu: MenuBonusItem[] = []): number {
  const menuMap = new Map(menu.map((item) => [item.id, item]));
  return lines.reduce((sum, line) => sum + getMenuSalaryBonus(menuMap.get(line.menuItemId)), 0);
}

export function calcPayrollByMenu(
  master: string,
  lines: ShiftLineWithBonus[],
  fixed: number | null,
  helpers = 0,
  menu: MenuBonusItem[] = [],
  employees: PayrollEmployee[] = DEFAULT_EMPLOYEE_SALARIES,
): number {
  const members = splitShiftMembers(master);
  // «Оклад этой смены» — переопределение для одного мастера. В совместной
  // смене поле не имеет смысла (и скрыто в UI), поэтому оставляем оклады
  // участников — так же считает сервер (`calculateShiftPayroll` в routes/pos.ts).
  const fixedBase =
    members.length === 1 && fixed !== null && fixed !== undefined ? fixed : null;
  const base =
    fixedBase ??
    members.reduce((sum, name) => sum + getMemberBaseSalary(name, lines.length, employees), 0);
  const lineBonuses = calcMenuBonusPool(lines, menu);

  // Joint shifts: every member keeps their own base salary and the full menu
  // bonus pool is added on top of the shift, so the members can split it evenly
  // (see calcMasterPayrollShare). Verified against the September 2026 sheet:
  // «Ренат/Амид», 14 Классики = 2500 + 3300 + 1400 = 7200 ₽.
  return base + lineBonuses + helpers;
}

/**
 * Доля одного мастера в смене: свой оклад + равная доля процента.
 * В совместной смене процент делится поровну между участниками, поэтому
 * «Ренат/Амид» с процентом 1400 ₽ даёт 3200 ₽ Ренату и 4000 ₽ Амиду, а сумма
 * долей всегда равна итогу смены из calcPayrollByMenu.
 */
export function calcMasterPayrollShare(
  shiftMaster: string,
  member: string,
  lines: ShiftLineWithBonus[],
  menu: MenuBonusItem[] = [],
  employees: PayrollEmployee[] = DEFAULT_EMPLOYEE_SALARIES,
  fixed: number | null = null,
): number {
  const members = splitShiftMembers(shiftMaster);
  if (!members.length) return 0;
  // Переопределение оклада действует только для одиночной смены: иначе каждый
  // участник получил бы всю сумму «оклада этой смены» целиком.
  const base =
    members.length === 1 && fixed !== null && fixed !== undefined
      ? fixed
      : getMemberBaseSalary(member, lines.length, employees);
  const share = calcMenuBonusPool(lines, menu) / members.length;
  return base + share;
}

/**
 * Динамические коэффициенты списания сырья. Дефолты раньше были захардкожены
 * в этом файле; теперь администратор переписывает их в настройках
 * (`state.usageSettings`), значения хранятся в БД и применяются ко всем новым
 * операциям — старые смены сохраняют формулу, с которой были списаны.
 */
export type UsageSettings = {
  /** кг угля на один кальян. */
  coalKgPerHookah: number;
  /** кг угля на один перезабив. */
  coalKgPerRebuild: number;
  /** г табака на один забив/перезабив. */
  tobaccoGramsPerRebuild: number;
};

/** Стартовые значения списания: 125 г угля на кальян/перезабив, 24 г табака. */
export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  coalKgPerHookah: 0.125,
  coalKgPerRebuild: 0.125,
  tobaccoGramsPerRebuild: 24,
};

/** Уголь на кальян — дефолт настроек списания (обратная совместимость). */
export const COAL_KG_PER_HOOKAH = DEFAULT_USAGE_SETTINGS.coalKgPerHookah;
/** Уголь на перезабив — дефолт настроек списания (обратная совместимость). */
export const COAL_KG_PER_REBUILD = DEFAULT_USAGE_SETTINGS.coalKgPerRebuild;
/** Табак на перезабив — дефолт настроек списания (обратная совместимость). */
export const TOBACCO_GRAMS_PER_REBUILD = DEFAULT_USAGE_SETTINGS.tobaccoGramsPerRebuild;

/**
 * Нормализация настроек: каждое поле — конечное число не меньше нуля,
 * иначе берётся дефолт. Пустое или битое значение из старых данных
 * не должно ломать расчёт смены.
 */
export function resolveUsageSettings(
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

/**
 * Проверка формы настроек в админке: `null` — ок, иначе текст ошибки.
 * Причина видна до запроса, как у `validateMenuItems`.
 */
export function validateUsageSettings(
  settings: Partial<UsageSettings> | null | undefined,
): string | null {
  const labels: Array<[keyof UsageSettings, string]> = [
    ["coalKgPerHookah", "Уголь на кальян"],
    ["coalKgPerRebuild", "Уголь на перезабивку"],
    ["tobaccoGramsPerRebuild", "Табак на перезабивку"],
  ];
  for (const [key, label] of labels) {
    const value = Number(settings?.[key]);
    if (!Number.isFinite(value) || value < 0) {
      return `${label}: укажите число не меньше 0`;
    }
  }
  return null;
}

export type ShiftLineWithTobaccoGrams = {
  tobaccoGrams: number;
};

function nonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/** Формат числа в формуле списания: без хвостовых нулей (0.125 → «0.125»). */
function formatAmount(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function calcCoalUsageKg(
  hookahCount: number,
  rebuildCount = 0,
  settings?: Partial<UsageSettings> | null,
): number {
  const usage = resolveUsageSettings(settings);
  return (
    nonNegative(hookahCount) * usage.coalKgPerHookah +
    nonNegative(rebuildCount) * usage.coalKgPerRebuild
  );
}

export function calcTobaccoUsageGrams(
  lines: ShiftLineWithTobaccoGrams[] = [],
  rebuildCount = 0,
  settings?: Partial<UsageSettings> | null,
): number {
  const usage = resolveUsageSettings(settings);
  const bowlGrams = lines.reduce(
    (sum, line) => sum + nonNegative(line?.tobaccoGrams),
    0,
  );
  return bowlGrams + nonNegative(rebuildCount) * usage.tobaccoGramsPerRebuild;
}

/**
 * Формула списания угля с фактическими коэффициентами — попадает в журнал
 * списаний (`usageLog.coalFormula`): «10 × 0.125 кг + 2 × 0.125 кг = 1.5 кг».
 */
export function formatCoalUsageFormula(
  hookahCount: number,
  rebuildCount = 0,
  settings?: Partial<UsageSettings> | null,
): string {
  const usage = resolveUsageSettings(settings);
  const hookahs = nonNegative(hookahCount);
  const rebuilds = nonNegative(rebuildCount);
  const parts: string[] = [];
  if (hookahs > 0) parts.push(`${hookahs} × ${formatAmount(usage.coalKgPerHookah)} кг`);
  if (rebuilds > 0) parts.push(`${rebuilds} × ${formatAmount(usage.coalKgPerRebuild)} кг`);
  const total = calcCoalUsageKg(hookahs, rebuilds, usage);
  const body = parts.length ? parts.join(" + ") : "0";
  return `${body} = ${formatAmount(total)} кг`;
}

/**
 * Формула списания табака: норма чаши плюс перезабивки —
 * «240 г + 2 × 24 г = 288 г».
 */
export function formatTobaccoUsageFormula(
  lines: ShiftLineWithTobaccoGrams[] = [],
  rebuildCount = 0,
  settings?: Partial<UsageSettings> | null,
): string {
  const usage = resolveUsageSettings(settings);
  const bowlGrams = lines.reduce(
    (sum, line) => sum + nonNegative(line?.tobaccoGrams),
    0,
  );
  const rebuilds = nonNegative(rebuildCount);
  const parts: string[] = [];
  if (bowlGrams > 0) parts.push(`${formatAmount(bowlGrams)} г`);
  if (rebuilds > 0) parts.push(`${rebuilds} × ${formatAmount(usage.tobaccoGramsPerRebuild)} г`);
  const total = calcTobaccoUsageGrams(lines, rebuilds, usage);
  const body = parts.length ? parts.join(" + ") : "0";
  return `${body} = ${formatAmount(total)} г`;
}

// ---------------------------------------------------------------------------
// Конструктор правил списания сырья
// ---------------------------------------------------------------------------

export type UsageRuleOperation = "sale" | "rebuild";

/**
 * Правило списания из конструктора: название, материал (позиция склада),
 * расход за операцию и тип операции — «при продаже позиции» или «при
 * перезабиве». Для sale можно сузить до конкретной позиции меню
 * (`menuItemId`), null — любая продажа.
 */
export type UsageRule = {
  id: string;
  name: string;
  inventoryId: string;
  amount: number;
  operation: UsageRuleOperation;
  menuItemId?: string | null;
  enabled: boolean;
};

/** Минимальный срез складской позиции, нужный для расчёта расхода. */
export type UsageInventoryItem = {
  id: string;
  name: string;
  category: string;
  stock: number;
  unit: string;
};

export type UsageShiftLine = { menuItemId: string; tobaccoGrams?: number };
export type UsageShiftLike = { lines: UsageShiftLine[]; rebuilds?: number | null };

/** Варианты типа операции для <select> в конструкторе правил. */
export const USAGE_RULE_OPERATIONS: Array<{ id: UsageRuleOperation; label: string }> = [
  { id: "sale", label: "При продаже позиции" },
  { id: "rebuild", label: "При перезабиве" },
];

/** Единица расхода правила — единица привязанной позиции склада (кг/г/шт.). */
export function usageRuleUnit(
  rule: Pick<UsageRule, "inventoryId">,
  inventory: UsageInventoryItem[] = [],
): string {
  return inventory.find((item) => item.id === rule.inventoryId)?.unit ?? "г";
}

/** Сколько операций срабатывает по правилу в смене. */
export function usageRuleHits(rule: UsageRule, shift: UsageShiftLike): number {
  if (rule.operation === "rebuild") return nonNegative(shift?.rebuilds);
  const lines = shift?.lines ?? [];
  if (!rule.menuItemId) return lines.length;
  return lines.filter((line) => line?.menuItemId === rule.menuItemId).length;
}

/** Проверка правила перед сохранением: null — ок, иначе текст ошибки. */
export function validateUsageRule(
  rule: Partial<UsageRule> | null | undefined,
  inventory: UsageInventoryItem[] = [],
): string | null {
  if (!rule?.name?.trim()) return "укажите название правила";
  if (!rule.inventoryId || !inventory.some((item) => item.id === rule.inventoryId)) {
    return "выберите материал: позиция склада из имеющихся";
  }
  const amount = Number(rule.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return "расход сырья — число не меньше 0";
  }
  if (rule.operation !== "sale" && rule.operation !== "rebuild") {
    return "тип операции: «При продаже позиции» или «При перезабиве»";
  }
  return null;
}

/** Отбрасывает структурно негодные правила из старых данных. */
export function resolveUsageRules(rules?: UsageRule[] | null): UsageRule[] {
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

/** Одна строка-источник в журнале списаний (база или правило админа). */
export type UsageSource = {
  ruleId: string;
  ruleName: string;
  amount: number;
  unit: string;
};

export type ShiftUsageDemand = {
  /** Категория склада → суммарный расход (coal — кг, остальные — по unit). */
  byCategory: Record<string, number>;
  coalKg: number;
  tobaccoGrams: number;
  /** Какими правилами (базовыми и ручными) получен расход. */
  sources: UsageSource[];
};

/**
 * Суммарный расход смены: сканируются все активные правила — базовые
 * коэффициенты (`usageSettings`) и правила администратора (`usageRules`).
 * Считает и клиент (живая сводка, автосписание), и сервер (валидация
 * остатков, журнал) — формулы обязаны совпадать.
 */
export function evalShiftUsage(
  shift: UsageShiftLike,
  inventory: UsageInventoryItem[] = [],
  settings?: Partial<UsageSettings> | null,
  rules?: UsageRule[] | null,
): ShiftUsageDemand {
  const usage = resolveUsageSettings(settings);
  const activeRules = resolveUsageRules(rules);
  const rebuilds = nonNegative(shift?.rebuilds);
  const lines = shift?.lines ?? [];
  const byCategory: Record<string, number> = {};
  const sources: UsageSource[] = [];
  const add = (category: string, amount: number) => {
    if (amount <= 0) return;
    byCategory[category] = (byCategory[category] ?? 0) + amount;
  };

  // Базовые коэффициенты — уголь.
  const coalHookah = lines.length * usage.coalKgPerHookah;
  const coalRebuild = rebuilds * usage.coalKgPerRebuild;
  add("coal", coalHookah + coalRebuild);
  if (coalHookah > 0) {
    sources.push({ ruleId: "base-coal-hookah", ruleName: "Уголь на кальян", amount: coalHookah, unit: "кг" });
  }
  if (coalRebuild > 0) {
    sources.push({ ruleId: "base-coal-rebuild", ruleName: "Уголь на перезабив", amount: coalRebuild, unit: "кг" });
  }

  // Базовые коэффициенты — табак: норма чаши + перезабивки.
  const bowlGrams = lines.reduce((sum, line) => sum + nonNegative(line?.tobaccoGrams), 0);
  const tobaccoRebuild = rebuilds * usage.tobaccoGramsPerRebuild;
  add("tobacco", bowlGrams + tobaccoRebuild);
  if (bowlGrams > 0) {
    sources.push({ ruleId: "base-tobacco-bowl", ruleName: "Норма чаши", amount: bowlGrams, unit: "г" });
  }
  if (tobaccoRebuild > 0) {
    sources.push({
      ruleId: "base-tobacco-rebuild",
      ruleName: "Табак на перезабив",
      amount: tobaccoRebuild,
      unit: "г",
    });
  }

  // Правила администратора: материал берётся из склада, расход — в его единицах.
  for (const rule of activeRules) {
    if (!rule.enabled) continue;
    const item = inventory.find((entry) => entry.id === rule.inventoryId);
    if (!item) continue;
    const amount = nonNegative(rule.amount) * usageRuleHits(rule, shift);
    if (amount <= 0) continue;
    add(inventoryCategorySelectValue(item.category), amount);
    sources.push({ ruleId: rule.id, ruleName: rule.name.trim() || "Правило", amount, unit: item.unit });
  }

  return {
    byCategory,
    coalKg: byCategory.coal ?? 0,
    tobaccoGrams: byCategory.tobacco ?? 0,
    sources,
  };
}

export type UsageAllocation = {
  /** Позиция склада → сумма к списанию в единицах позиции. */
  byItem: Record<string, number>;
  /** true — остатков не хватило, списание провалось. */
  short: boolean;
};

/**
 * Раскладка расхода по конкретным позициям склада. Базовые суммы идут по
 * позициям категории в порядке каталога (как старый `consumeInventory`),
 * правило администратора списывает прежде всего свою привязанную позицию и
 * только остаток — с остальных позиций той же категории.
 */
export function allocateShiftUsage(
  shift: UsageShiftLike,
  inventory: UsageInventoryItem[] = [],
  settings?: Partial<UsageSettings> | null,
  rules?: UsageRule[] | null,
): UsageAllocation {
  const usage = resolveUsageSettings(settings);
  const rebuilds = nonNegative(shift?.rebuilds);
  const lines = shift?.lines ?? [];

  type Chunk = { category: string; targetId?: string; amount: number };
  const chunks: Chunk[] = [];
  const coalAmount =
    lines.length * usage.coalKgPerHookah + rebuilds * usage.coalKgPerRebuild;
  if (coalAmount > 0) chunks.push({ category: "coal", amount: coalAmount });
  const bowlGrams = lines.reduce((sum, line) => sum + nonNegative(line?.tobaccoGrams), 0);
  const tobaccoAmount = bowlGrams + rebuilds * usage.tobaccoGramsPerRebuild;
  if (tobaccoAmount > 0) chunks.push({ category: "tobacco", amount: tobaccoAmount });
  for (const rule of resolveUsageRules(rules)) {
    if (!rule.enabled) continue;
    const item = inventory.find((entry) => entry.id === rule.inventoryId);
    if (!item) continue;
    const amount = nonNegative(rule.amount) * usageRuleHits(rule, shift);
    if (amount <= 0) continue;
    chunks.push({
      category: inventoryCategorySelectValue(item.category),
      targetId: item.id,
      amount,
    });
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
      if (inventoryCategorySelectValue(item.category) !== chunk.category) continue;
      remaining = takeFrom(item.id, remaining);
    }
    if (remaining > 1e-9) short = true;
  }

  return { byItem, short };
}

export type ReportPeriod = "day" | "week" | "month";

const toIsoDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Границы отчёта в формате YYYY-MM-DD.
 *
 * - «День» — сама выбранная дата.
 * - «Месяц» — календарный месяц выбранной даты.
 * - «Неделя» — если задан свой диапазон (`rangeStart`/`rangeEnd`), берётся он,
 *   то есть можно смотреть любые «с … по …». Пустая граница подставляется из
 *   автоматического диапазона (7 дней до выбранной даты), а перепутанные
 *   границы меняются местами.
 */
export function resolveReportRange(
  period: ReportPeriod,
  selectedDate: string,
  rangeStart?: string | null,
  rangeEnd?: string | null,
): { from: string; to: string } {
  const parsed = new Date(`${selectedDate}T12:00:00`);
  // Пустая или некорректная дата (пользователь очистил поле) не должна ломать
  // фильтр — берём текущий день.
  const current = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  if (period === "week") {
    const fallbackStart = new Date(current);
    fallbackStart.setDate(fallbackStart.getDate() - 6);
    const from = rangeStart?.trim() || toIsoDate(fallbackStart);
    const to = rangeEnd?.trim() || toIsoDate(current);
    return from <= to ? { from, to } : { from: to, to: from };
  }

  if (period === "month") {
    const first = new Date(current);
    first.setDate(1);
    const last = new Date(current);
    last.setMonth(last.getMonth() + 1);
    last.setDate(0);
    return { from: toIsoDate(first), to: toIsoDate(last) };
  }

  return { from: toIsoDate(current), to: toIsoDate(current) };
}

/** Кому адресуется отдельная доплата — владельцу заведения. */
export const SHIFT_BONUS_OWNER_NAME = "Амид";

/**
 * Отдельная корректировка Амиду (поле «Амиду дополнительно»). Раньше сумма
 * писалась внутрь смены (`shift.amidExtra`) и участвовала в её статусе и
 * расчётах; теперь это изолированная операция в `state.amidAdjustments`,
 * которая не открывает, не закрывает и не регистрирует смену.
 */
export type AmidAdjustment = {
  date: string;
  amount?: number | null;
};

/** Корректировки Амиду, попадающие в период отчёта [from, to] (YYYY-MM-DD). */
export function filterAmidAdjustmentsInRange(
  adjustments: AmidAdjustment[] | null | undefined,
  from?: string | null,
  to?: string | null,
): AmidAdjustment[] {
  return (adjustments ?? []).filter(
    (item) =>
      Number.isFinite(Number(item?.amount)) &&
      Number(item.amount) >= 0 &&
      (!from || item.date >= from) &&
      (!to || item.date <= to),
  );
}

/** Сумма отдельных корректировок Амиду за период отчёта. */
export function sumAmidAdjustments(
  adjustments: AmidAdjustment[] | null | undefined,
  from?: string | null,
  to?: string | null,
): number {
  return filterAmidAdjustmentsInRange(adjustments, from, to).reduce(
    (sum, item) => sum + nonNegative(item.amount),
    0,
  );
}

/**
 * Доля мастера в смене. Доплаты Амиду в расчёт не входят: они учитываются
 * отдельно через `amidAdjustments` (см. `sumAmidAdjustments`).
 */
export function calcMasterShiftPayout(
  shift: { master: string; fixedSalary?: number | null },
  member: string,
  lines: ShiftLineWithBonus[],
  menu: MenuBonusItem[] = [],
  employees: PayrollEmployee[] = DEFAULT_EMPLOYEE_SALARIES,
): number {
  const members = splitShiftMembers(shift.master);
  if (!members.includes(member)) {
    return 0;
  }
  return calcMasterPayrollShare(
    shift.master,
    member,
    lines,
    menu,
    employees,
    shift.fixedSalary ?? null,
  );
}
