/**
 * Smoke-тест API кассы против запущенного сервера.
 *
 *   pnpm --filter @workspace/api-server run build
 *   PORT=10000 SESSION_SECRET=dev pnpm --filter @workspace/api-server run start
 *   pnpm run smoke            # SMOKE_BASE=http://127.0.0.1:10000/api
 *
 * Проверяет вход по PIN, защиту состояния сессией, optimistic-блокировку,
 * серверный пересчёт журнала списаний (формулы и раскладку по складу),
 * проверку остатков и прав работника. Ничего не пишет в репозиторий, кроме
 * состояния демо-хранилища самого сервера (`.data/pos-state.json`).
 */
const BASE = process.env.SMOKE_BASE?.trim() || "http://127.0.0.1:10000/api";
const RUN = `smoke-${Date.now()}`;
let failures = 0;

function check(name, condition, extra = "") {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

async function login(pin) {
  const res = await fetch(`${BASE}/pos/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: res.status, cookie, body: await res.json() };
}

async function api(path, cookie, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Списание по категории в порядке каталога — как это делает клиент. */
function deduct(inventory, category, amount) {
  let remaining = amount;
  return inventory.map((item) => {
    if (item.category !== category || remaining <= 0) return item;
    const used = Math.min(item.stock, remaining);
    remaining -= used;
    return { ...item, stock: item.stock - used };
  });
}

function stockOf(inventory, category) {
  return inventory
    .filter((item) => item.category === category)
    .reduce((sum, item) => sum + item.stock, 0);
}

function makeShift({ id, date, lines, rebuilds = 0 }) {
  return {
    id,
    date,
    master: "Олег",
    lines,
    helpersPay: 0,
    purchaseAmount: 0,
    rebuilds,
    comment: "",
    fixedSalary: null,
    createdAt: new Date().toISOString(),
  };
}

const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const classicLine = (suffix) => ({
  id: `${RUN}-line-${suffix}`,
  menuItemId: "classic",
  menuItemName: "Классика",
  unitPrice: 1500,
  tobaccoGrams: 24,
  discount: 0,
  reason: "",
});

const admin = await login("0000");
check("admin login", admin.status === 200 && admin.body.role === "admin", JSON.stringify(admin.body));

const anonymous = await api("/pos/state", "");
check("state requires a session", anonymous.status === 401, String(anonymous.status));

const stateRes = await api("/pos/state", admin.cookie);
check("state loads", stateRes.status === 200, String(stateRes.status));
if (stateRes.status !== 200) {
  console.log("\nSMOKE FAILURES: cannot read the state, stopping");
  process.exit(1);
}
const state = stateRes.body;
check("state has usageRules", Array.isArray(state.usageRules));
check("state has usageLog", Array.isArray(state.usageLog));
check("state has inventory", Array.isArray(state.inventory) && state.inventory.length > 0);

const roundTrip = await api("/pos/state", admin.cookie, {
  method: "PUT",
  body: JSON.stringify(state),
});
check("unchanged state saves", roundTrip.status === 200, JSON.stringify(roundTrip.body).slice(0, 200));

const stale = await api("/pos/state", admin.cookie, {
  method: "PUT",
  body: JSON.stringify({ ...state, updatedAt: state.updatedAt }),
});
check("stale updatedAt is rejected with 409", stale.status === 409, String(stale.status));

let current = roundTrip.body;
const coalBefore = stockOf(current.inventory, "coal");
const tobaccoBefore = stockOf(current.inventory, "tobacco");
const shift = makeShift({
  id: `${RUN}-shift`,
  date: today,
  lines: [classicLine(1), classicLine(2)],
  rebuilds: 1,
});
const added = await api("/pos/state", admin.cookie, {
  method: "PUT",
  body: JSON.stringify({
    ...current,
    inventory: deduct(deduct(current.inventory, "coal", 0.375), "tobacco", 72),
    shifts: [shift, ...current.shifts],
  }),
});
check("shift saves", added.status === 200, JSON.stringify(added.body).slice(0, 300));
if (added.status === 200) {
  current = added.body;
  const entry = current.usageLog.find((row) => row.shiftId === shift.id);
  check("usage log entry created", Boolean(entry));
  if (entry) {
    check(
      "coal formula: 2 hookahs + 1 rebuild",
      entry.coalKg === 0.375 && /2 × 0\.125 кг \+ 1 × 0\.125 кг = 0\.375 кг/.test(entry.coalFormula),
      `${entry.coalKg} / ${entry.coalFormula}`,
    );
    check(
      "tobacco formula: 48 g bowls + 24 g rebuild",
      entry.tobaccoGrams === 72 && /48 г \+ 1 × 24 г = 72 г/.test(entry.tobaccoFormula),
      `${entry.tobaccoGrams} / ${entry.tobaccoFormula}`,
    );
    check("usage log has per-item allocation", Array.isArray(entry.items) && entry.items.length > 0);
  }
  check(
    "coal deducted by 0.375 kg",
    Math.abs(coalBefore - stockOf(current.inventory, "coal") - 0.375) < 1e-9,
  );
  check(
    "tobacco deducted by 72 g",
    Math.abs(tobaccoBefore - stockOf(current.inventory, "tobacco") - 72) < 1e-9,
  );
}

const worker = await login("1111");
check("worker login", worker.status === 200 && worker.body.role === "worker", JSON.stringify(worker.body));
const workerState = await api("/pos/state", worker.cookie);
check("worker can read state", workerState.status === 200);

const workerEdit = await api("/pos/state", worker.cookie, {
  method: "PUT",
  body: JSON.stringify({
    ...workerState.body,
    menu: workerState.body.menu.map((item) => ({ ...item, price: 1 })),
  }),
});
check("worker menu edit is forbidden", workerEdit.status === 403, String(workerEdit.status));

const workerShift = makeShift({
  id: `${RUN}-shift-worker`,
  date: today,
  lines: [classicLine(3)],
});
const workerSave = await api("/pos/state", worker.cookie, {
  method: "PUT",
  body: JSON.stringify({
    ...workerState.body,
    inventory: deduct(deduct(workerState.body.inventory, "coal", 0.125), "tobacco", 24),
    shifts: [workerShift, ...workerState.body.shifts],
  }),
});
check(
  "worker can add a shift for today",
  workerSave.status === 200,
  `${workerSave.status} ${JSON.stringify(workerSave.body).slice(0, 200)}`,
);

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILURES: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
