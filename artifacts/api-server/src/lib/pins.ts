import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * PIN-коды входа в терминал. В базе хранятся только хеши (scrypt + соль):
 * посмотреть старый PIN нельзя, можно лишь заменить его новым.
 *
 * Дефолты (`0000` — администратор, `1111` — работник) можно переопределить
 * переменными окружения POS_ADMIN_PIN / POS_WORKER_PIN — они действуют, пока
 * владелец не задал свои коды в «Настройки → PIN-коды входа».
 */
export type PinRole = "admin" | "worker";

export type PinHash = { salt: string; hash: string };

export type PinsRecord = {
  admin?: PinHash;
  worker?: PinHash;
  /** Когда коды последний раз меняли (ISO), null — используются дефолты. */
  updatedAt?: string;
};

export const PIN_ROLES: readonly PinRole[] = ["admin", "worker"];

export const PIN_LENGTH = 4;
const PIN_PATTERN = /^\d{4}$/;
const SALT_BYTES = 16;
const KEY_LENGTH = 32;

export const DEFAULT_PINS: Record<PinRole, string> = {
  admin: "0000",
  worker: "1111",
};

const ROLE_LABELS: Record<PinRole, string> = {
  admin: "PIN администратора",
  worker: "PIN работника",
};

export function roleLabel(role: PinRole): string {
  return ROLE_LABELS[role];
}

/** Стартовый PIN роли: переменная окружения, если она валидна, иначе дефолт. */
export function defaultPin(role: PinRole): string {
  const fromEnv = (
    role === "admin" ? process.env.POS_ADMIN_PIN : process.env.POS_WORKER_PIN
  )?.trim();
  return fromEnv && PIN_PATTERN.test(fromEnv) ? fromEnv : DEFAULT_PINS[role];
}

export function isValidPin(value: unknown): value is string {
  return typeof value === "string" && PIN_PATTERN.test(value);
}

export function hashPin(pin: string): PinHash {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  return { salt, hash: scryptSync(pin, salt, KEY_LENGTH).toString("hex") };
}

/** Проверка PIN по сохранённому хешу (сравнение без утечки по времени). */
export function verifyPin(pin: string, record: PinHash | null | undefined): boolean {
  if (!record?.salt || !record?.hash) return false;
  const expected = Buffer.from(record.hash, "hex");
  if (expected.length !== KEY_LENGTH) return false;
  try {
    return timingSafeEqual(expected, scryptSync(pin, record.salt, KEY_LENGTH));
  } catch {
    return false;
  }
}

/** Сравнение с дефолтным PIN без утечки по времени. */
export function matchesPin(pin: string, expected: string): boolean {
  const left = Buffer.from(pin);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Какая роль соответствует введённому PIN. Если для роли сохранён свой код,
 * дефолт для неё уже не действует — иначе смена PIN не закрывала бы старый вход.
 */
export function roleForPin(
  pin: string,
  record?: PinsRecord | null,
): PinRole | null {
  if (!isValidPin(pin)) return null;
  for (const role of PIN_ROLES) {
    const stored = record?.[role];
    const matches = stored ? verifyPin(pin, stored) : matchesPin(pin, defaultPin(role));
    if (matches) return role;
  }
  return null;
}

/** Приводит запись из базы к безопасному виду (битые поля отбрасываются). */
export function normalizePinsRecord(value: unknown): PinsRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const record: PinsRecord = {};
  for (const role of PIN_ROLES) {
    const entry = raw[role];
    if (!entry || typeof entry !== "object") continue;
    const { salt, hash } = entry as Record<string, unknown>;
    if (typeof salt === "string" && salt && typeof hash === "string" && hash) {
      record[role] = { salt, hash };
    }
  }
  if (typeof raw.updatedAt === "string" && raw.updatedAt) {
    record.updatedAt = raw.updatedAt;
  }
  return record.admin || record.worker || record.updatedAt ? record : null;
}

/**
 * PIN администратора и работника должны различаться — иначе вход неоднозначен
 * (первым проверяется администратор). Сравнивать можно только известные в
 * открытом виде коды: новые значения из запроса и дефолты тех ролей, для
 * которых владелец ещё не задал свой код.
 */
export function findPinConflict(
  input: { adminPin?: string; workerPin?: string },
  record?: PinsRecord | null,
): string | null {
  const effective = (role: PinRole): string | null => {
    const incoming = role === "admin" ? input.adminPin : input.workerPin;
    if (incoming !== undefined) return incoming;
    return record?.[role] ? null : defaultPin(role);
  };
  const admin = effective("admin");
  const worker = effective("worker");
  if (admin && worker && admin === worker) {
    return "PIN администратора и PIN работника должны различаться";
  }
  return null;
}
