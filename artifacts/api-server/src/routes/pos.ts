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
const BASE_PRICES = new Set([1500, 2000, 2500, 3600]);
const STAFF_NAMES = new Set([
  "Амид",
  "Амид + Олег",
  "Амид + Ренат",
  "Олег",
  "Ренат",
  "Максим",
]);
const sessionSecret = process.env.SESSION_SECRET;

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
  menu: [
    { id: "classic", name: "Классический", price: 1500, tobaccoGrams: 24, enabled: true },
    { id: "grapefruit", name: "Грейпфрут", price: 2000, tobaccoGrams: 27, enabled: true },
    { id: "pineapple", name: "Ананас", price: 2500, tobaccoGrams: 27, enabled: true },
    { id: "signature", name: "Авторский", price: 3600, tobaccoGrams: 27, enabled: true },
  ],
  permissions: {
    menuItemIds: ["classic", "grapefruit", "pineapple", "signature"],
    seeRevenue: false,
    useDiscounts: true,
    addInventory: true,
    editPastInventory: false,
    editPastShifts: false,
  },
  inventory: [
    { id: "coal", name: "Кокосовый уголь", category: "coal", brand: "", packageGrams: 1000, stock: 10, unit: "кг" },
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
  if (rows[0]) return GetPosStateResponse.parse(rows[0].state);

  await db
    .insert(posStateTable)
    .values({ id: 1, state: initialState as Record<string, unknown> })
    .onConflictDoNothing();
  const created = await db.select().from(posStateTable).limit(1);
  if (!created[0]) throw new Error("Unable to initialize POS state");
  return GetPosStateResponse.parse(created[0].state);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function totalUsage(state: PosState): { coalKg: number; tobaccoGrams: number } {
  let coalKg = 0;
  let tobaccoGrams = 0;
  for (const shift of state.shifts) {
    coalKg += shift.lines.length * 0.072 + shift.refills * 0.036;
    tobaccoGrams += shift.lines.reduce((sum, line) => sum + line.tobaccoGrams, 0);
    tobaccoGrams += shift.refills * 24;
  }
  return { coalKg, tobaccoGrams };
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
    if (!STAFF_NAMES.has(shift.master) || shift.lines.length === 0) {
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

router.post("/pos/login", (req, res) => {
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
    res.status(401).json({ error: "Неверный PIN-код" });
    return;
  }
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

router.put("/pos/state", async (req, res) => {
  const role = requireRole(req, res);
  if (!role) return;
  const parsed = SavePosStateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Данные смены или настроек имеют неверный формат" });
    return;
  }
  if (parsed.data.menu.some((item) => !BASE_PRICES.has(item.price))) {
    res.status(400).json({ error: "Цена позиции должна соответствовать одному из базовых тарифов" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
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