import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, posStateTable } from "@workspace/db";
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
const MENU_DEFINITIONS = [
  { id: "classic", name: "Классика", price: 1500, tobaccoGrams: 24, salaryBonus: 100 },
  { id: "grapefruit", name: "Грейпфрут", price: 2000, tobaccoGrams: 27, salaryBonus: 150 },
  { id: "pineapple", name: "Ананас", price: 2500, tobaccoGrams: 27, salaryBonus: 150 },
  { id: "barbie", name: "Барби", price: 0, tobaccoGrams: 27, salaryBonus: 0 },
  { id: "signature", name: "Авторский", price: 3600, tobaccoGrams: 27, salaryBonus: 500 },
] as const;
// Автоматическое списание сырья: уголь — 72 г на кальян и 36 г на перезабивку
// чаши, табак — по норме чаши плюс 24 г на каждую перезабивку.
const COAL_KG_PER_HOOKAH = 0.072;
const COAL_KG_PER_REBUILD = 0.036;
const TOBACCO_GRAMS_PER_REBUILD = 24;
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
  const secure =
    process.env.NODE_ENV === "production" ||
    process.env.REPLIT_DEPLOYMENT === "1" ||
    process.env.REPLIT_DEV_DOMAIN !== undefined;
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(role))}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`,
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
  coalOpeningKg: 10,
  updatedAt: new Date().toISOString(),
};

async function getOrCreateState(): Promise<PosState> {
  const rows = await db.select().from(posStateTable).limit(1);
  if (rows[0]) {
    const parsed = GetPosStateResponse.parse(rows[0].state);
    return { ...parsed, employees: parsed.employees?.length ? parsed.employees : DEFAULT_EMPLOYEES };
  }

  await db
    .insert(posStateTable)
    .values({ id: 1, state: initialState as Record<string, unknown> })
    .onConflictDoNothing();
  const created = await db.select().from(posStateTable).limit(1);
  if (!created[0]) throw new Error("Unable to initialize POS state");
  const parsed = GetPosStateResponse.parse(created[0].state);
  return { ...parsed, employees: parsed.employees?.length ? parsed.employees : DEFAULT_EMPLOYEES };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function totalUsage(state: PosState): { coalKg: number; tobaccoGrams: number } {
  let coalKg = 0;
  let tobaccoGrams = 0;
  for (const shift of state.shifts) {
    const rebuilds = shift.rebuilds ?? 0;
    coalKg += shift.lines.length * COAL_KG_PER_HOOKAH + rebuilds * COAL_KG_PER_REBUILD;
    tobaccoGrams +=
      shift.lines.reduce((sum, line) => sum + line.tobaccoGrams, 0) +
      rebuilds * TOBACCO_GRAMS_PER_REBUILD;
  }
  return { coalKg, tobaccoGrams };
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
  const rebuilds = shift.rebuilds ?? 0;
  const coalNeeded =
    shift.lines.length * COAL_KG_PER_HOOKAH + rebuilds * COAL_KG_PER_REBUILD;
  const tobaccoNeeded =
    shift.lines.reduce((sum, line) => sum + line.tobaccoGrams, 0) +
    rebuilds * TOBACCO_GRAMS_PER_REBUILD;

  const nextInventory = [...state.inventory];
  const coalItem = nextInventory.find((item) => item.category === "coal");
  if (coalItem) {
    coalItem.stock = Math.max(0, coalItem.stock - coalNeeded);
  }

  const tobaccoList = nextInventory.filter((item) => item.category === "tobacco");
  let remaining = tobaccoNeeded;
  for (const item of tobaccoList) {
    if (remaining <= 0) break;
    const used = Math.min(item.stock, remaining);
    item.stock = Math.max(0, item.stock - used);
    remaining -= used;
  }

  return { ...state, inventory: nextInventory };
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
    (!permissions.editPastInventory &&
      current.coalOpeningKg !== next.coalOpeningKg)
  ) {
    return "Работник не может менять настройки, меню и начальные остатки";
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

  const currentUsage = totalUsage(current);
  const nextUsage = totalUsage(next);
  const stockDelta = (category: string) =>
    next.inventory
      .filter((item) => categoryIs(item.category, category as "coal" | "tobacco"))
      .reduce((sum, item) => sum + item.stock, 0) -
    current.inventory
      .filter((item) => categoryIs(item.category, category as "coal" | "tobacco"))
      .reduce((sum, item) => sum + item.stock, 0);
  const expectedCoalDelta = -(nextUsage.coalKg - currentUsage.coalKg);
  const expectedTobaccoDelta = -(
    nextUsage.tobaccoGrams - currentUsage.tobaccoGrams
  );
  const coalDelta = stockDelta("coal");
  const tobaccoDelta = stockDelta("tobacco");
  const positiveStockChange = (category: "coal" | "tobacco") =>
    next.inventory
      .filter((item) => categoryIs(item.category, category))
      .reduce((sum, item) => {
        const previous = currentInventory.get(item.id);
        return sum + Math.max(0, item.stock - (previous?.stock ?? 0));
      }, 0);
  const coalReceipts = Math.max(
    0,
    positiveStockChange("coal") - Math.max(0, expectedCoalDelta),
  );
  const tobaccoReceipts = Math.max(
    0,
    positiveStockChange("tobacco") - Math.max(0, expectedTobaccoDelta),
  );
  if (
    !permissions.editPastInventory &&
    Math.abs(coalDelta - expectedCoalDelta - coalReceipts) > 0.0001
  ) {
    return "Остаток угля должен учитывать автоматический расход и приёмку";
  }
  if (
    !permissions.editPastInventory &&
    Math.abs(tobaccoDelta - expectedTobaccoDelta - tobaccoReceipts) > 0.0001
  ) {
    return "Остаток табака должен учитывать автоматический расход и приёмку";
  }
  const receipts = coalReceipts + tobaccoReceipts;
  if (
    receipts > 0.0001 &&
    !permissions.addInventory &&
    !permissions.editPastInventory
  ) {
    return "Нет разрешения на добавление товаров в инвентарь";
  }
  for (const item of next.inventory) {
    if (!categoryIs(item.category, "coal") && !categoryIs(item.category, "tobacco")) {
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
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
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
      const current = GetPosStateResponse.parse(rows[0].state);

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