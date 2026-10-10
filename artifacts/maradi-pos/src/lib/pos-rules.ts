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
  const base =
    fixed ??
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
  const base = fixed ?? getMemberBaseSalary(member, lines.length, employees);
  const share = calcMenuBonusPool(lines, menu) / members.length;
  return base + share;
}

/** Уголь: 0.072 кг (72 г) на каждый кальян. */
export const COAL_KG_PER_HOOKAH = 0.125;
/** Уголь: 0.036 кг (36 г) на каждую перезабивку чаши. */
export const COAL_KG_PER_REBUILD = 0.125;
/** Табак: 24 г на каждую перезабивку чаши. */
export const TOBACCO_GRAMS_PER_REBUILD = 24;

export type ShiftLineWithTobaccoGrams = {
  tobaccoGrams: number;
};

function nonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export function calcCoalUsageKg(hookahCount: number, rebuildCount = 0): number {
  return (
    nonNegative(hookahCount) * COAL_KG_PER_HOOKAH +
    nonNegative(rebuildCount) * COAL_KG_PER_REBUILD
  );
}

export function calcTobaccoUsageGrams(
  lines: ShiftLineWithTobaccoGrams[] = [],
  rebuildCount = 0,
): number {
  const bowlGrams = lines.reduce(
    (sum, line) => sum + nonNegative(line?.tobaccoGrams),
    0,
  );
  return bowlGrams + nonNegative(rebuildCount) * TOBACCO_GRAMS_PER_REBUILD;
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
