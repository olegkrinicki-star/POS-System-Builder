import { Fragment, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  useGetPosSession, useLoginPos, useLogoutPos, useGetPosState, useSavePosState,
  getGetPosStateQueryKey,
} from '@workspace/api-client-react';
import type { PosState, Shift, ShiftLine, InventoryItem, MenuItem } from '@workspace/api-client-react';
import {
  calcCoalUsageKg,
  calcMasterPayrollShare,
  calcMasterShiftPayout,
  calcPayrollByMenu,
  calcTobaccoUsageGrams,
  DEFAULT_EMPLOYEE_SALARIES,
  DEFAULT_MENU_SALARY_BONUSES,
  DEFAULT_CALCULATION_RULES,
  DEFAULT_USAGE_SETTINGS,
  resolveUsageSettings,
  validateUsageSettings,
  evalShiftUsage,
  allocateShiftUsage,
  validateUsageRule,
  usageRuleUnit,
  USAGE_RULE_OPERATIONS,
  type UsageRule,
  type UsageSettings,
  type CalculationRule,
  filterAmidAdjustmentsInRange,
  inventoryCategorySelectValue,
  inventoryUnitForCategory,
  nextCalculationRuleId,
  validateCalculationRules,
  resolveReportRange,
  sumAmidAdjustments,
  SHIFT_BONUS_OWNER_NAME,
  formatMenuIssue,
  MAX_TOBACCO_GRAMS,
  MIN_TOBACCO_GRAMS,
  parseNumericInput,
  validateMenuItems,
} from '@/lib/pos-rules';

type MenuItemWithBonus = MenuItem & { salaryBonus?: number };

const getMenuSalaryBonus = (menu: MenuItemWithBonus[], itemId?: string): number => {
  const item = menu.find((entry) => entry.id === itemId);
  const bonus = Number((item as { salaryBonus?: number } | undefined)?.salaryBonus ?? DEFAULT_MENU_SALARY_BONUSES[itemId as keyof typeof DEFAULT_MENU_SALARY_BONUSES] ?? 0);
  return Number.isFinite(bonus) ? bonus : 0;
};
import {
  ArrowDownToLine, BarChart3, Boxes, Check, ChevronRight, CircleHelp, Clock3,
  Coffee, DoorOpen, Flame, LockKeyhole, Plus, Settings2, ShieldCheck, Trash2,
  TrendingUp, Users, X, Pencil, RotateCcw,
} from 'lucide-react';import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';import NotFound from '@/pages/not-found';

const qc = new QueryClient();
type Employee = NonNullable<PosState['employees']>[number];
const DEFAULT_EMPLOYEES: Employee[] = DEFAULT_EMPLOYEE_SALARIES.map((employee, index) => ({
  id: ['amid', 'oleg', 'renat', 'maxim', 'kirill'][index],
  ...employee,
}));
const BARBIE_MENU_ITEM: MenuItem = {
  id: 'barbie',
  name: 'Барби',
  price: 0,
  tobaccoGrams: 27,
  enabled: false,
  salaryBonus: 0,
};
const withSpreadsheetMenuItems = (menu: MenuItem[]) =>
  menu.some((item) => item.id === BARBIE_MENU_ITEM.id) ? menu : [...menu, BARBIE_MENU_ITEM];
const getEmployees = (employees?: Employee[]) => employees?.length ? employees : DEFAULT_EMPLOYEES;
const getShiftMembers = (master: string) => master.split(/\s*[+/]\s*/).filter(Boolean);
const DISCOUNTS = [0, 50, 100] as const;
const ruDate = (v: string) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(v));
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const localDate = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const saleAmount = (price: number, discount: number) => price * (1 - discount / 100);
const categoryKind = (value: string): 'coal' | 'tobacco' | 'other' => {
  const category = value.trim().toLocaleLowerCase('ru-RU');
  if (category === 'coal' || category === 'уголь') return 'coal';
  if (category === 'tobacco' || category === 'табак') return 'tobacco';
  return 'other';
};
/** Компактные инпуты внутри ячеек таблицы остатков (общие .input слишком высокие). */
const EDIT_CELL_INPUT_STYLE = { padding: '8px 10px', fontSize: 12 };

/** Общий контекст расчёта расхода: настройки + правила конструктора. */
type UsageContext = { usage?: Partial<UsageSettings> | null; rules?: UsageRule[] | null };

/** Расход смены по категориям склада — сканирует базу и правила администратора. */
function shiftUsageCategories(
  shift: Shift,
  inventory: InventoryItem[],
  ctx: UsageContext,
): Record<string, number> {
  return evalShiftUsage(shift, inventory, ctx.usage, ctx.rules).byCategory;
}

/** Списать сумму с позиций категории в порядке каталога (null — не хватило). */
function consumeCategory(
  inventory: InventoryItem[],
  category: string,
  amount: number,
): InventoryItem[] | null {
  let remaining = amount;
  const next = inventory.map((item) => {
    if (inventoryCategorySelectValue(item.category) !== category || remaining <= 0) return item;
    const used = Math.min(item.stock, remaining);
    remaining -= used;
    return { ...item, stock: item.stock - used };
  });
  return remaining > 0.0001 ? null : next;
}

/** Вернуть уменьшившийся расход на первую позицию категории. */
function restoreCategory(
  inventory: InventoryItem[],
  category: string,
  amount: number,
): InventoryItem[] | null {
  if (amount <= 0) return inventory;
  const first = inventory.find(
    (item) => inventoryCategorySelectValue(item.category) === category,
  );
  if (!first) return null;
  return inventory.map((item) =>
    item.id === first.id ? { ...item, stock: item.stock + amount } : item,
  );
}

/**
 * Правка/удаление прошлой смены: разница расхода старой и новой версии
 * возвращается на склад или списывается — по всем категориям, затронутым
 * базовыми коэффициентами и правилами.
 */
function adjustForShiftChange(
  inventory: InventoryItem[],
  previous: Shift,
  next: Shift | null,
  ctx: UsageContext,
): InventoryItem[] | null {
  const previousDemand = shiftUsageCategories(previous, inventory, ctx);
  const nextDemand = next ? shiftUsageCategories(next, inventory, ctx) : {};
  const categories = new Set([
    ...Object.keys(previousDemand),
    ...Object.keys(nextDemand),
  ]);
  let result: InventoryItem[] | null = inventory;
  for (const category of categories) {
    if (!result) return null;
    const delta = (previousDemand[category] ?? 0) - (nextDemand[category] ?? 0);
    result =
      delta > 0
        ? restoreCategory(result, category, delta)
        : consumeCategory(result, category, -delta);
  }
  return result;
}
const DEFAULT_STATE: PosState = {
  menu: [
    { id: 'classic', name: 'Классика', price: 1500, tobaccoGrams: 24, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.classic },
    { id: 'grapefruit', name: 'Грейпфрут', price: 2000, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.grapefruit },
    { id: 'pineapple', name: 'Ананас', price: 2500, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.pineapple },
    { ...BARBIE_MENU_ITEM },
    { id: 'signature', name: 'Авторский', price: 3600, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.signature },
  ],
  employees: DEFAULT_EMPLOYEES,
  permissions: {
    menuItemIds: ['classic', 'grapefruit', 'pineapple', 'barbie', 'signature'],
    seeRevenue: false,
    useDiscounts: true,
    addInventory: true,
    editPastInventory: false,
    editPastShifts: false,
  },
  inventory: [],
  containers: [],
  shifts: [],
  calculationRules: DEFAULT_CALCULATION_RULES,
  usageSettings: { ...DEFAULT_USAGE_SETTINGS },
  usageRules: [],
  usageLog: [],
  coalOpeningKg: 0,
  updatedAt: new Date().toISOString(),
};

function AppInner() {
  const queryClient = useQueryClient();
  const sessionQuery = useGetPosSession();
  const session = sessionQuery.data;
  const loggedIn = !!session?.authenticated;
  const stateQuery = useGetPosState({ query: { enabled: loggedIn, queryKey: getGetPosStateQueryKey(), retry: 1 } });
  const login = useLoginPos();
  const logout = useLogoutPos();
  const save = useSavePosState();
  const saveError = save.error instanceof Error ? save.error.message : '';
  const [currentPath, setLocation] = useLocation();
  const [state, setState] = useState<PosState | null>(null);

  useEffect(() => { if (stateQuery.data) setState(stateQuery.data); else if (!stateQuery.isLoading && !stateQuery.isError) setState(DEFAULT_STATE); }, [stateQuery.data, stateQuery.isLoading, stateQuery.isError]);
  const persist = (next: PosState, onSuccess?: () => void) => {
    const payload = { ...next, updatedAt: state?.updatedAt ?? next.updatedAt };
    save.mutate({ data: payload }, {
      onSuccess: (saved) => {
        setState(saved);
        queryClient.setQueryData(getGetPosStateQueryKey(), saved);
        onSuccess?.();
      },
      onError: (error) => {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status?: unknown }).status) : 0;
        if (status === 409) {
          stateQuery.refetch().then(result => { if (result.data) setState(result.data); });
        }
      },
    });
  };
  const role = session?.role ?? 'worker';
  const canRevenue = role === 'admin' || !!state?.permissions.seeRevenue;
  const isAdmin = role === 'admin';
  const isStateLoading = loggedIn && stateQuery.isLoading;

  useEffect(() => {
    // Wait for the session check first: during the initial render every deep link
    // looks unauthenticated, and the redirect used to bounce /reports (and other
    // deep links) to / and then to /shift.
    if (sessionQuery.isLoading) return;
    if (loggedIn && currentPath === '/') setLocation('/shift');
    if (!loggedIn && currentPath !== '/') setLocation('/');
  }, [sessionQuery.isLoading, loggedIn, currentPath, setLocation]);

  if (sessionQuery.isLoading) return <LoadingScreen />;
  if (sessionQuery.isError) return <QueryError title="Не удалось проверить вход" retry={() => sessionQuery.refetch()} />;
  if (!loggedIn) return <LoginScreen pending={login.isPending} error={login.error} onLogin={(pin) => login.mutate({ data: { pin } }, { onSuccess: (s) => { queryClient.setQueryData(['/api/pos/session'], s); sessionQuery.refetch(); } })} />;
  if (stateQuery.isError) return <Shell role={role} logout={() => logout.mutate(undefined)}><QueryError title="Не удалось загрузить данные смены" retry={() => stateQuery.refetch()} /></Shell>;
  if (isStateLoading || !state) return <Shell role={role} logout={() => logout.mutate(undefined, { onSuccess: () => { setState(null); queryClient.setQueryData(['/api/pos/session'], { authenticated: false, role: null }); sessionQuery.refetch(); setLocation('/'); } })}><LoadingScreen inline /></Shell>;
  if (!state) return <LoadingScreen />;

  // Колбэк обязателен: страницы сбрасывают форму и выходят из режима
  // редактирования только после успешного ответа сервера.
  const saveState = (next: PosState, onSuccess?: () => void) => persist(next, onSuccess);
  const shared = { state, saveState, role, canRevenue, isAdmin, saving: save.isPending, saveError };
  const onLogout = () => logout.mutate(undefined, { onSuccess: () => { setState(null); queryClient.setQueryData(['/api/pos/session'], { authenticated: false, role: null }); sessionQuery.refetch(); setLocation('/'); } });
  return <Shell role={role} logout={onLogout} saving={save.isPending} saveFailed={save.isError} saveError={saveError}>
    <Switch>
      <Route path="/shift"><ShiftPage {...shared} /></Route>
      <Route path="/inventory"><InventoryPage {...shared} /></Route>
      <Route path="/reports"><ReportsPage {...shared} /></Route>
      <Route path="/settings"><SettingsPage {...shared} /></Route>
      <Route component={NotFound} />
    </Switch>
  </Shell>;
}

function LoadingScreen({ inline = false }: { inline?: boolean }) {
  return <div className={inline ? 'page' : 'min-h-screen flex items-center justify-center'}><div style={{ width: inline ? '100%' : 320 }} className="grid gap-3"><div className="skeleton" /><div className="skeleton" style={{ height: 78 }} /></div></div>;
}
function QueryError({ title, retry }: { title: string; retry: () => void }) {
  return <div className="page"><div className="card" style={{ maxWidth: 520, margin: '8vh auto', textAlign: 'center' }}><div className="eyebrow">Связь с терминалом</div><h2 style={{ margin: '0 0 10px' }}>{title}</h2><p className="subhead">Проверьте соединение и попробуйте ещё раз. Записи не будут потеряны.</p><button className="btn btn-primary" onClick={retry} data-testid="button-retry"><RotateCcw size={15} /> Повторить</button></div></div>;
}

/**
 * Числовое поле с текстовым черновиком.
 *
 * Если держать в состоянии само число (`value={newPrice}` и `Number(e.target.value)`),
 * поле невозможно очистить: при стирании значение мгновенно становится 0 и цифры
 * возвращаются на место, поэтому вручную вписать цену или граммовку нельзя —
 * особенно с телефона. Здесь поле помнит текст, пока в него печатают, а наружу
 * отдаёт число (`emptyValue`, если строку очистили).
 */
function NumberField({
  value,
  onCommit,
  emptyValue = 0,
  ...rest
}: {
  value: number;
  onCommit: (next: number) => void;
  emptyValue?: number;
} & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'>) {
  const [text, setText] = useState<string | null>(null);
  const display = text ?? (Number.isFinite(value) ? String(value) : '');
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={display}
      onChange={(e) => {
        const raw = e.target.value;
        // Поле ведёт себя как числовое (только цифры и разделитель), но с
        // `inputMode="decimal"` на телефоне доступна запятая для дробей.
        if (!/^[\d\s.,-]*$/.test(raw)) return;
        setText(raw);
        onCommit(parseNumericInput(raw, emptyValue));
      }}
      onBlur={() => setText(null)}
    />
  );
}

function LoginScreen({ pending, error, onLogin }: { pending: boolean; error: unknown; onLogin: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState('');
  const push = (n: string) => { if (pin.length < 4) { setPin(pin + n); setMessage(''); } };
  const submit = () => { if (pin.length !== 4) { setMessage('Введите четыре цифры'); return; } onLogin(pin); };
  useEffect(() => { if (error) setMessage('PIN не подошёл. Проверьте код и попробуйте снова.'); }, [error]);
  return <main className="login-wrap">
    <section className="login-art">
      <div className="brand"><div className="brand-mark">М</div> МАРАДИ <span style={{ color: '#777970', font: '11px Manrope', letterSpacing: '.2em' }}>POS</span></div>
      <div className="login-copy"><div className="eyebrow">Рабочий терминал · смена начинается здесь</div><h1>Порядок<br />в каждой<br /><span style={{ color: '#d4aa4c' }}>смене.</span></h1><p>Продажи, остатки и расчёты команды — в одном спокойном ритме.</p></div>
      <div className="login-foot">ТЕРМИНАЛ МАРАДИ · ДЛЯ КОМАНДЫ</div>
    </section>
    <section className="login-panel"><div className="login-box">
      <div className="eyebrow">Добро пожаловать</div><h2 className="display" style={{ fontSize: 32, margin: 0 }}>Вход по PIN</h2>
      <p className="subhead">Введите персональный четырёхзначный код</p>
      <div className="pin-display" aria-label={`Введено ${pin.length} цифр`}>{[0, 1, 2, 3].map(i => <span key={i} className={`pin-dot ${pin.length > i ? 'filled' : ''}`} />)}</div>
      <div className="keypad">{['1','2','3','4','5','6','7','8','9','⌫','0','Сбросить'].map(k => <button key={k} className="key" onClick={() => k === '⌫' ? setPin(pin.slice(0, -1)) : k === 'Сбросить' ? setPin('') : push(k)} data-testid={`key-${k}`}>{k}</button>)}<button className="key submit" onClick={submit} disabled={pending} data-testid="button-login">{pending ? 'Проверяем код…' : 'Продолжить'}</button></div>
      {message && <p style={{ color: '#df897d', textAlign: 'center', fontSize: 12 }}>{message}</p>}
      <div className="divider" /><div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: '#777b81', fontSize: 11 }}><LockKeyhole size={14} /> Доступ защищён PIN-кодом</div>
    </div></section>
  </main>;
}

function Shell({ children, role, logout, saving = false, saveFailed = false, saveError = '' }: { children: ReactNode; role: string; logout: () => void; saving?: boolean; saveFailed?: boolean; saveError?: string }) {
  const [path] = useLocation();
  const nav = [{ href: '/shift', label: 'Смена', icon: Coffee }, { href: '/inventory', label: 'Склад', icon: Boxes }, { href: '/reports', label: 'Отчёты', icon: BarChart3 }, { href: '/settings', label: 'Настройки', icon: Settings2 }];
  const activeTab = nav.some((item) => item.href === path) ? path : '/shift';

  return <div className="app-shell">
    <header className="topbar"><Link href="/shift" className="brand"><span className="brand-mark">М</span> МАРАДИ <span style={{ color: '#777970', font: '10px Manrope', letterSpacing: '.2em' }}>POS</span></Link>
      <div className="nav">
        <Tabs value={activeTab} className="w-full max-w-xl">
          <TabsList className="h-10 rounded-full bg-[#202329] p-1 text-[#dfe3e9]">
            {nav.map((n) => {
              const Icon = n.icon;
              return (
                <TabsTrigger key={n.href} value={n.href} asChild className="rounded-full px-3 py-2 data-[state=active]:bg-[#d4aa4c] data-[state=active]:text-[#1b1b1d]">
                  <Link href={n.href} className="inline-flex items-center gap-2">
                    <Icon size={16} />
                    <span>{n.label}</span>
                  </Link>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      </div>
      <div className="top-right">{saving && <span className="saving">Сохраняем…</span>}{saveFailed && <span role="alert" className="saving" style={{color:'#df897d'}} title={saveError || undefined}>Не сохранено · причина в Настройках</span>}<span className="role-pill">{role === 'admin' ? 'Администратор' : 'Сотрудник'}</span><div className="user-chip"><span className="avatar">{role === 'admin' ? 'A' : 'С'}</span><span>Терминал</span></div><button title="Выйти" className="btn btn-quiet btn-sm" onClick={logout} data-testid="button-logout"><DoorOpen size={16} /></button></div>
    </header>
    <main>{children}</main>
    <nav className="mobile-nav">{nav.map(n => { const Icon = n.icon; return <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><Icon size={18} /><span>{n.label}</span></Link>; })}</nav>
  </div>;
}

type Shared = { state: PosState; saveState: (state: PosState, onSuccess?: () => void) => void; role: string; canRevenue: boolean; isAdmin: boolean; saving: boolean; saveError: string };

function ShiftPage({
  state,
  saveState,
  role,
  canRevenue,
  isAdmin,
  saving,
}: Shared) {
  const employees = getEmployees(state.employees);
  // Актуальные коэффициенты списания: администратор меняет их в настройках,
  // смена считает по сохранённым в БД значениям.
  const usage = resolveUsageSettings(state.usageSettings);
  const [selectedEmployees, setSelectedEmployees] = useState<string[]>(() => employees[0] ? [employees[0].name] : []);
  const master = selectedEmployees.join(' + ');
  const toggleEmployee = (name: string) => setSelectedEmployees((current) => {
    if (current.includes(name)) return current.length > 1 ? current.filter((employee) => employee !== name) : current;
    return [...current, name];
  });
  const [lines, setLines] = useState<ShiftLine[]>([]);
  const [helpersPay, setHelpersPay] = useState(0);
  const [purchaseAmount, setPurchaseAmount] = useState(0);
  const [rebuilds, setRebuilds] = useState(0);
  // Черновик отдельной корректировки Амиду: он не входит в объект смены и не
  // участвует в saveShift — запись идёт только через saveAmidExtra, поэтому
  // ввод суммы не открывает, не закрывает и не регистрирует смену.
  const [amidExtra, setAmidExtra] = useState(0);
  const [amidMsg, setAmidMsg] = useState("");
  // Черновик плашки «Правила расчёта»: null — просмотр, массив — режим правки.
  const [rulesDraft, setRulesDraft] = useState<CalculationRule[] | null>(null);
  // Конструктор правил списания: null — просмотр, иначе черновик правила.
  const [usageRuleDraft, setUsageRuleDraft] = useState<
    { rule: UsageRule; isNew: boolean } | null
  >(null);
  const [comment, setComment] = useState("");
  const [fixedSalary, setFixedSalary] = useState<number | "">("");
  const [date, setDate] = useState(localDate());
  const [discountOpen, setDiscountOpen] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState("");
  const allowedMenu = state.menu.filter(
    (item) =>
      item.enabled &&
      (isAdmin || state.permissions.menuItemIds.includes(item.id)),
  );
  const total = lines.reduce(
    (sum, line) => sum + saleAmount(line.unitPrice, line.discount),
    0,
  );
  const payroll =
    calcPayrollByMenu(
      master,
      lines.map((line) => ({ menuItemId: line.menuItemId })),
      fixedSalary === "" ? null : Number(fixedSalary),
      helpersPay,
      state.menu as MenuItemWithBonus[],
      employees,
    );
  const addLine = (menu: MenuItem) => {
    if (!saving)
      setLines((prev) => [
        ...prev,
        {
          id: uid(),
          menuItemId: menu.id,
          menuItemName: menu.name,
          unitPrice: menu.price,
          tobaccoGrams: menu.tobaccoGrams,
          discount: 0,
          reason: "",
        },
      ]);
  };
  const changeLine = (id: string, patch: Partial<ShiftLine>) => {
    if (!saving)
      setLines((prev) =>
        prev.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      );
  };
  const saveShift = () => {
    if (saving) return;
    if (!lines.length) return;
    if (lines.some((line) => line.discount > 0 && !line.reason.trim())) {
      window.alert("Укажите причину для каждой скидки.");
      return;
    }
    const shift: Shift = {
      id: uid(),
      date,
      master,
      lines,
      helpersPay: Number(helpersPay) || 0,
      purchaseAmount: Math.max(0, Number(purchaseAmount)),
      rebuilds: Math.max(0, Math.floor(rebuilds)),
      comment,
      fixedSalary: fixedSalary === "" ? null : Number(fixedSalary),
      createdAt: new Date().toISOString(),
    };
    // Автосписание по всем активным правилам: базовые коэффициенты плюс
    // правила конструктора. Раскладка — по позициям склада, как на сервере.
    const allocation = allocateShiftUsage(
      shift,
      state.inventory,
      usage,
      state.usageRules,
    );
    if (allocation.short) {
      window.alert(
        "Недостаточно сырья на складе для списания по правилам. Сначала внесите поставку или скорректируйте остаток.",
      );
      return;
    }
    const withUsage = state.inventory.map((item) => {
      const used = allocation.byItem[item.id];
      return used ? { ...item, stock: item.stock - used } : item;
    });
    saveState(
      { ...state, inventory: withUsage, shifts: [shift, ...state.shifts] },
      () => {
        setLines([]);
        setHelpersPay(0);
        setPurchaseAmount(0);
        setRebuilds(0);
        setComment("");
        setFixedSalary("");
        setSavedMsg("Смена записана в журнал");
        window.setTimeout(() => setSavedMsg(""), 3500);
      },
    );
  };
  // Изолированная операция: сохраняет только корректировку Амиду, не трогая
  // черновик смены, склад и журнал смен.
  const saveAmidExtra = () => {
    if (saving) return;
    const amount = Math.max(0, Math.floor(Number(amidExtra) || 0));
    if (!amount) return;
    const adjustment = {
      id: uid(),
      date: localDate(),
      amount,
      comment: "",
      createdAt: new Date().toISOString(),
    };
    saveState(
      { ...state, amidAdjustments: [adjustment, ...(state.amidAdjustments ?? [])] },
      () => {
        setAmidExtra(0);
        setAmidMsg(`Доплата ${rub(amount)} записана отдельно от смены`);
        window.setTimeout(() => setAmidMsg(""), 3500);
      },
    );
  };
  // Плашка «Правила расчёта»: динамический список под полным контролем владельца.
  // Работникам карандаш не показываем — сервер всё равно отклонит правку.
  const calculationRules = state.calculationRules ?? DEFAULT_CALCULATION_RULES;
  const startRulesEdit = () =>
    setRulesDraft(calculationRules.map((rule) => ({ ...rule })));
  const cancelRulesEdit = () => setRulesDraft(null);
  const changeRuleDraft = (id: number, patch: Partial<CalculationRule>) =>
    setRulesDraft((prev) =>
      prev
        ? prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
        : prev,
    );
  const removeRuleDraft = (id: number) =>
    setRulesDraft((prev) =>
      prev ? prev.filter((rule) => rule.id !== id) : prev,
    );
  const addRuleDraft = () =>
    setRulesDraft((prev) =>
      prev
        ? [
            ...prev,
            { id: nextCalculationRuleId(prev), name: "", rule: "" },
          ]
        : prev,
    );
  const saveRules = () => {
    if (!rulesDraft || saving) return;
    const trimmed = rulesDraft.map((rule) => ({
      ...rule,
      name: rule.name.trim(),
      rule: rule.rule.trim(),
    }));
    const issue = validateCalculationRules(trimmed);
    if (issue) return window.alert(issue);
    saveState({ ...state, calculationRules: trimmed }, () => setRulesDraft(null));
  };
  // Конструктор правил списания сырья (state.usageRules): каждое правило —
  // название, материал со склада, расход и тип операции. Сохраняется в БД и
  // применяется к новым сменам сразу; правила склада работник не меняет.
  const usageRulesList = state.usageRules ?? [];
  const startNewUsageRule = () => {
    if (!state.inventory.length) {
      window.alert("Сначала добавьте позицию на склад — правилу нужен материал.");
      return;
    }
    setUsageRuleDraft({
      rule: {
        id: uid(),
        name: "",
        inventoryId: state.inventory[0].id,
        amount: 0,
        operation: "sale",
        menuItemId: null,
        enabled: true,
      },
      isNew: true,
    });
  };
  const startEditUsageRule = (rule: UsageRule) =>
    setUsageRuleDraft({ rule: { ...rule }, isNew: false });
  const cancelUsageRuleDraft = () => setUsageRuleDraft(null);
  const saveUsageRuleDraft = () => {
    if (!usageRuleDraft || saving) return;
    const { rule, isNew } = usageRuleDraft;
    const issue = validateUsageRule(rule, state.inventory);
    if (issue) return window.alert(issue);
    const trimmed: UsageRule = {
      ...rule,
      name: rule.name.trim(),
      amount: Number(rule.amount),
      menuItemId: rule.operation === "sale" ? rule.menuItemId || null : null,
    };
    const nextRules = isNew
      ? [...usageRulesList, trimmed]
      : usageRulesList.map((entry) =>
          entry.id === trimmed.id ? trimmed : entry,
        );
    saveState({ ...state, usageRules: nextRules }, () => setUsageRuleDraft(null));
  };
  const deleteUsageRule = (id: string) => {
    if (!window.confirm("Удалить правило списания?")) return;
    saveState(
      { ...state, usageRules: usageRulesList.filter((entry) => entry.id !== id) },
      () => setUsageRuleDraft(null),
    );
  };
  const visibleRevenue = canRevenue;
  // Живая сводка списания: сканирует базовые коэффициенты и правила
  // конструктора — ровно то, что будет вычтено со склада при закрытии смены.
  const draftUsage = evalShiftUsage(
    { lines, rebuilds },
    state.inventory,
    usage,
    state.usageRules,
  );
  const kgUsed = draftUsage.coalKg;
  const tobacco = draftUsage.tobaccoGrams;
  const customUsageSources = draftUsage.sources.filter(
    (source) => !source.ruleId.startsWith("base-"),
  );
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Операционный журнал / сегодня</div>
          <h1>Ввод смены</h1>
          <div className="subhead">
            Зафиксируйте каждую чашу и расходы команды до закрытия.
          </div>
        </div>
        <div className="tag green">
          <span
            style={{
              width: 7,
              height: 7,
              background: "#8bb49c",
              borderRadius: 9,
              marginRight: 7,
            }}
          />
          Смена открыта
        </div>
      </div>
      {savedMsg && (
        <div className="notice" style={{ marginBottom: 16 }}>
          {savedMsg}
        </div>
      )}
      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0,1.55fr) minmax(300px,.85fr)",
          alignItems: "start",
        }}
      >
        <section className="grid">
          <div className="card">
            <div className="section-title">
              <span>01 / Кто на смене</span>
              <Users size={16} color="#b69a59" />
            </div>
            <div
              className="grid"
              style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}
            >
              <div>
                <label className="label">Сотрудники на смене</label>
                <div className="employee-picker" role="group" aria-label="Сотрудники на смене" data-testid="select-master">
                  {employees.map((employee) => (
                    <label key={employee.id} className={`employee-option ${selectedEmployees.includes(employee.name) ? "selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selectedEmployees.includes(employee.name)}
                        onChange={() => toggleEmployee(employee.name)}
                        aria-label={employee.name}
                      />
                      <span>{employee.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">Дата смены</label>
                <input
                  className="input"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  data-testid="input-shift-date"
                />
              </div>
            </div>
            <div className="divider" />
            <div className="section-title">
              <span>Добавить кальян</span>
              <span className="tag">{lines.length} в смене</span>
            </div>
            {allowedMenu.length ? (
              <div className="menu-grid">
                {allowedMenu.map((item) => (
                  <button
                    key={item.id}
                    className="menu-tile"
                    onClick={() => addLine(item)}
                    data-testid={`button-add-${item.id}`}
                  >
                    <span>{item.name}</span>
                    <span className="grams">{item.tobaccoGrams} г</span>
                    <div className="price">{rub(item.price)}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                Для вашей учётной записи пока не открыты позиции меню.
              </div>
            )}
          </div>
          <div className="card">
            <div className="section-title">
              <span>02 / Позиции смены</span>
              <span className="tag gold">{lines.length} кальянов</span>
            </div>
            {!lines.length ? (
              <div className="empty">
                Выберите позицию меню — она появится здесь.
              </div>
            ) : (
              lines.map((line, idx) => {
                return (
                  <div
                    className="line-row"
                    key={line.id}
                    data-testid={`row-shift-line-${line.id}`}
                  >
                    <div>
                      <b style={{ fontSize: 12 }}>
                        {idx + 1}. {line.menuItemName}
                      </b>
                      <div className="subhead" style={{ marginTop: 3 }}>
                        {line.tobaccoGrams} г табака
                      </div>
                    </div>
                    {state.permissions.useDiscounts || isAdmin ? (
                      <div
                        className="discount-options"
                        role="group"
                        aria-label="Скидка"
                        data-testid={`select-discount-${line.id}`}
                      >
                        {DISCOUNTS.map((discount) => (
                          <button
                            key={discount}
                            type="button"
                            className={`discount-option ${line.discount === discount ? "active" : ""}`}
                            aria-label={discount === 0 ? "Без скидки" : `Скидка ${discount}%`}
                            aria-pressed={line.discount === discount}
                            onClick={() => {
                              changeLine(line.id, {
                                discount,
                                reason: discount ? line.reason : "",
                              });
                              setDiscountOpen(discount ? line.id : null);
                            }}
                          >
                            {discount}%
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="tag">Без скидки</span>
                    )}
                    <span
                      className="mono"
                      style={{ textAlign: "right", fontSize: 12 }}
                    >
                      {rub(saleAmount(line.unitPrice, line.discount))}
                    </span>
                    <button
                      className="btn btn-quiet btn-sm"
                      aria-label="Удалить кальян"
                      onClick={() =>
                        setLines((prev) => prev.filter((l) => l.id !== line.id))
                      }
                      data-testid={`button-remove-line-${line.id}`}
                    >
                      <X size={16} />
                    </button>
                    {discountOpen === line.id && (
                      <div
                        style={{ gridColumn: "1 / -1", padding: "4px 0 8px" }}
                      >
                        <label className="label">Причина скидки</label>
                        <input
                          className="input"
                          placeholder="Например: постоянный гость"
                          value={line.reason}
                          onChange={(e) =>
                            changeLine(line.id, { reason: e.target.value })
                          }
                          data-testid={`input-discount-reason-${line.id}`}
                        />
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div className="divider" />
            <div
              className="grid"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 11 }}
            >
              <div>
                <label className="label">Помощникам, ₽</label>
                <NumberField
                  className="input"
                  min="0"
                  value={helpersPay}
                  onCommit={(next) => setHelpersPay(Math.max(0, next))}
                  data-testid="input-helpers-pay"
                />
              </div>
              <div>
                <label className="label">Перезабивки</label>
                <NumberField
                  className="input"
                  min="0"
                  step="1"
                  value={rebuilds}
                  onCommit={(next) => setRebuilds(Math.max(0, Math.floor(next)))}
                  data-testid="input-rebuilds"
                />
              </div>
              {canRevenue && (
                <div>
                  <label className="label">Закупка за смену, ₽</label>
                  <NumberField
                    className="input"
                    min="0"
                    step="1"
                    value={purchaseAmount}
                    onCommit={(next) => setPurchaseAmount(Math.max(0, next))}
                    data-testid="input-purchase-amount"
                  />
                </div>
              )}
              {selectedEmployees.length === 1 && (
                <div>
                  <label className="label">Оклад этой смены, ₽</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    placeholder="По умолчанию"
                    value={fixedSalary}
                    onChange={(e) =>
                      setFixedSalary(
                        e.target.value === "" ? "" : Number(e.target.value),
                      )
                    }
                    data-testid="input-fixed-salary"
                  />
                </div>
              )}
            </div>
            <div style={{ marginTop: 12 }}>
              <label className="label">Комментарий к смене</label>
              <textarea
                className="textarea"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Особые обстоятельства, списания…"
                data-testid="input-shift-comment"
              />
            </div>
          </div>
          <div className="card">
            <div className="section-title">
              <span>03 / Отдельная операция</span>
              <ArrowDownToLine size={16} color="#b69a59" />
            </div>
            <p style={{ color: "#858990", fontSize: 11, lineHeight: 1.6, margin: "0 0 13px" }}>
              Доплата {SHIFT_BONUS_OWNER_NAME}у записывается отдельной записью: она не открывает,
              не закрывает и не меняет смену, но учитывается в ФОТ и в расчёте по мастерам.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px" }}>
                <label className="label">{`${SHIFT_BONUS_OWNER_NAME}у дополнительно, ₽`}</label>
                <NumberField
                  className="input"
                  min="0"
                  step="1"
                  value={amidExtra}
                  onCommit={(next) => setAmidExtra(Math.max(0, next))}
                  placeholder="0"
                  data-testid="input-amid-extra"
                />
              </div>
              <button
                className="btn btn-primary"
                style={{ minHeight: 42 }}
                disabled={saving || !(Math.max(0, Number(amidExtra) || 0) > 0)}
                onClick={saveAmidExtra}
                data-testid="button-save-amid-extra"
              >
                <Check size={16} /> Записать отдельно
              </button>
            </div>
            {amidMsg && (
              <div className="notice" style={{ marginTop: 12 }}>
                {amidMsg}
              </div>
            )}
          </div>
        </section>
        <aside className="grid">
          <div
            className="card"
            style={{
              borderColor: "#54472d",
              background: "linear-gradient(150deg,#242117,#191a1d)",
            }}
          >
            <div className="section-title">
              <span>Сводка смены</span>
              <Clock3 size={16} color="#d4aa4c" />
            </div>
            {visibleRevenue ? (
              <>
                <div className="kpi-label">ВЫРУЧКА ПО ПОЗИЦИЯМ</div>
                <div className="kpi-value">{rub(total)}</div>
                <div className="divider" />
              </>
            ) : (
              <div className="notice" style={{ marginBottom: 17 }}>
                Выручка скрыта настройками доступа.
              </div>
            )}
            <div style={{ display: "grid", gap: 12 }}>
              <SummaryRow label="Кальяны" value={`${lines.length} шт.`} />
              <SummaryRow
                label="Уголь списан"
                value={`${kgUsed.toFixed(3)} кг`}
              />
              <SummaryRow label="Табак учтён" value={`${tobacco} г`} />
              {customUsageSources.map((source) => (
                <SummaryRow
                  key={source.ruleId}
                  label={source.ruleName}
                  value={`${Math.round(source.amount * 1000) / 1000} ${source.unit}`}
                />
              ))}
              {canRevenue && (
                <>
                  <SummaryRow
                    label="Зарплата сотрудников"
                    value={rub(payroll)}
                    highlight
                  />
                  {selectedEmployees.length > 1 &&
                    selectedEmployees.map((name) => (
                      <SummaryRow
                        key={name}
                        label={`↳ ${name}: оклад + доля процента`}
                        value={rub(
                          calcMasterPayrollShare(
                            master,
                            name,
                            lines,
                            state.menu as MenuItemWithBonus[],
                            employees,
                            null,
                          ),
                        )}
                      />
                    ))}
                  <SummaryRow label="Закупка" value={rub(purchaseAmount)} />
                  <SummaryRow label="Помощники" value={rub(helpersPay)} />
                </>
              )}
            </div>
</div>
</aside>
            <button
              className="btn btn-primary"
              style={{ width: "100%", marginTop: 23, minHeight: 46 }}
              disabled={!lines.length || saving}
              onClick={saveShift}
              data-testid="button-save-shift"
            >
              <Check size={16} /> {saving ? "Сохраняем…" : "Записать смену"}
            </button>
            <p
              style={{
                color: "#777b81",
                fontSize: 10,
                lineHeight: 1.5,
                textAlign: "center",
                margin: "12px 0 0",
              }}
            >
              Запись сохранится в общей истории и отчётах.
            </p>
          <div className="card">
            <div className="section-title">
              <span>Правила расчёта</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {isAdmin && rulesDraft === null && (
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={startRulesEdit}
                    aria-label="Редактировать правила"
                    title="Редактировать правила"
                    data-testid="button-edit-rules"
                  >
                    <Pencil size={15} />
                  </button>
                )}
                {isAdmin && rulesDraft !== null && (
                  <>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={saving}
                      onClick={saveRules}
                      data-testid="button-save-rules"
                    >
                      <Check size={14} /> Сохранить
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={saving}
                      onClick={cancelRulesEdit}
                      data-testid="button-cancel-rules"
                    >
                      Отмена
                    </button>
                  </>
                )}
                <CircleHelp size={16} color="#858990" />
              </span>
            </div>
            {rulesDraft === null ? (
              calculationRules.length ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    color: "#999da3",
                    fontSize: 11,
                    lineHeight: 1.5,
                  }}
                >
                  {calculationRules.map((rule) => (
                    <div key={rule.id}>
                      <b style={{ color: "#c9c6bd" }}>{rule.name}:</b>{" "}
                      {rule.rule}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">Правил пока нет.</div>
              )
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {rulesDraft.map((rule) => (
                  <div
                    key={rule.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) auto",
                      gap: 8,
                      alignItems: "start",
                    }}
                  >
                    <div style={{ display: "grid", gap: 8 }}>
                      <input
                        className="input"
                        style={EDIT_CELL_INPUT_STYLE}
                        value={rule.name}
                        onChange={(e) =>
                          changeRuleDraft(rule.id, { name: e.target.value })
                        }
                        placeholder="Название (например, Уголь)"
                        aria-label="Название правила"
                        data-testid={`input-rule-name-${rule.id}`}
                      />
                      <input
                        className="input"
                        style={EDIT_CELL_INPUT_STYLE}
                        value={rule.rule}
                        onChange={(e) =>
                          changeRuleDraft(rule.id, { rule: e.target.value })
                        }
                        placeholder="Описание правила (текст или нормы расхода)"
                        aria-label="Описание правила"
                        data-testid={`input-rule-text-${rule.id}`}
                      />
                    </div>
                    <button
                      className="btn btn-quiet btn-sm btn-danger"
                      onClick={() => removeRuleDraft(rule.id)}
                      aria-label="Удалить правило"
                      title="Удалить правило"
                      data-testid={`button-remove-rule-${rule.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-sm"
                  onClick={addRuleDraft}
                  data-testid="button-add-rule"
                >
                  <Plus size={14} /> Добавить правило
                </button>
              </div>
            )}
            <div className="divider" />
            <div className="section-title">
              <span>Правила списания сырья</span>
              {isAdmin && !usageRuleDraft && (
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={startNewUsageRule}
                  aria-label="Новое правило списания"
                  title="Новое правило списания"
                  data-testid="button-add-usage-rule"
                >
                  <Plus size={15} />
                </button>
              )}
            </div>
            <div className="notice" style={{ marginBottom: 12 }}>
              Базовые коэффициенты — уголь{" "}
              {Math.round(usage.coalKgPerHookah * 1000)} г на кальян и{" "}
              {Math.round(usage.coalKgPerRebuild * 1000)} г на перезабивку, табак{" "}
              {usage.tobaccoGramsPerRebuild} г на перезабивку — правятся в
              «Настройки → Расход сырья». Собственные правила списываются вместе
              с базой при закрытии смены.
            </div>
            {usageRuleDraft ? (
              <div
                className="grid"
                style={{
                  gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
                  gap: 9,
                  alignItems: "end",
                }}
              >
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="label">Название</label>
                  <input
                    className="input"
                    style={EDIT_CELL_INPUT_STYLE}
                    value={usageRuleDraft.rule.name}
                    onChange={(e) =>
                      setUsageRuleDraft({
                        ...usageRuleDraft,
                        rule: { ...usageRuleDraft.rule, name: e.target.value },
                      })
                    }
                    placeholder="Расход на фруктовую чашу"
                    aria-label="Название правила списания"
                    data-testid="input-usage-rule-name"
                  />
                </div>
                <div>
                  <label className="label">Материал (склад)</label>
                  <select
                    className="select"
                    style={EDIT_CELL_INPUT_STYLE}
                    value={usageRuleDraft.rule.inventoryId}
                    onChange={(e) =>
                      setUsageRuleDraft({
                        ...usageRuleDraft,
                        rule: {
                          ...usageRuleDraft.rule,
                          inventoryId: e.target.value,
                        },
                      })
                    }
                    aria-label="Материал правила"
                    data-testid="select-usage-rule-inventory"
                  >
                    {state.inventory.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">
                    Расход,{" "}
                    {usageRuleUnit(usageRuleDraft.rule, state.inventory)}
                  </label>
                  <NumberField
                    className="input"
                    style={EDIT_CELL_INPUT_STYLE}
                    min="0"
                    step="0.001"
                    value={usageRuleDraft.rule.amount}
                    onCommit={(next) =>
                      setUsageRuleDraft({
                        ...usageRuleDraft,
                        rule: { ...usageRuleDraft.rule, amount: next },
                      })
                    }
                    aria-label="Расход сырья за операцию"
                    data-testid="input-usage-rule-amount"
                  />
                </div>
                <div>
                  <label className="label">Операция</label>
                  <select
                    className="select"
                    style={EDIT_CELL_INPUT_STYLE}
                    value={usageRuleDraft.rule.operation}
                    onChange={(e) =>
                      setUsageRuleDraft({
                        ...usageRuleDraft,
                        rule: {
                          ...usageRuleDraft.rule,
                          operation: e.target
                            .value as UsageRule["operation"],
                          menuItemId:
                            e.target.value === "sale"
                              ? usageRuleDraft.rule.menuItemId ?? null
                              : null,
                        },
                      })
                    }
                    aria-label="Тип операции"
                    data-testid="select-usage-rule-operation"
                  >
                    {USAGE_RULE_OPERATIONS.map((operation) => (
                      <option key={operation.id} value={operation.id}>
                        {operation.label}
                      </option>
                    ))}
                  </select>
                </div>
                {usageRuleDraft.rule.operation === "sale" && (
                  <div>
                    <label className="label">Позиция меню</label>
                    <select
                      className="select"
                      style={EDIT_CELL_INPUT_STYLE}
                      value={usageRuleDraft.rule.menuItemId ?? ""}
                      onChange={(e) =>
                        setUsageRuleDraft({
                          ...usageRuleDraft,
                          rule: {
                            ...usageRuleDraft.rule,
                            menuItemId: e.target.value || null,
                          },
                        })
                      }
                      aria-label="Позиция меню правила"
                      data-testid="select-usage-rule-menu"
                    >
                      <option value="">Любая позиция</option>
                      {state.menu.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "#999da3",
                    paddingBottom: 8,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={usageRuleDraft.rule.enabled}
                    onChange={(e) =>
                      setUsageRuleDraft({
                        ...usageRuleDraft,
                        rule: {
                          ...usageRuleDraft.rule,
                          enabled: e.target.checked,
                        },
                      })
                    }
                    style={{ accentColor: "#d4aa4c", width: 16, height: 16 }}
                    data-testid="toggle-usage-rule-enabled"
                  />
                  Активно
                </label>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
                  <button
                    className="btn btn-primary"
                    style={{ minHeight: 42 }}
                    onClick={saveUsageRuleDraft}
                    disabled={saving}
                    data-testid="button-save-usage-rule"
                  >
                    Сохранить
                  </button>
                  <button
                    className="btn btn-quiet"
                    style={{ minHeight: 42 }}
                    onClick={cancelUsageRuleDraft}
                    data-testid="button-cancel-usage-rule"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : usageRulesList.length ? (
              <div style={{ display: "grid", gap: 10 }}>
                {usageRulesList.map((rule) => (
                  <div
                    key={rule.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) auto",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 12, color: "#e2ded4" }}>
                        {rule.name}
                        {!rule.enabled && (
                          <span className="tag" style={{ marginLeft: 8 }}>
                            выключено
                          </span>
                        )}
                      </div>
                      <div className="subhead" style={{ fontSize: 11 }}>
                        {USAGE_RULE_OPERATIONS.find(
                          (operation) => operation.id === rule.operation,
                        )?.label ?? rule.operation}{" "}
                        · {rule.amount} {usageRuleUnit(rule, state.inventory)}
                        {rule.menuItemId
                          ? ` · ${
                              state.menu.find(
                                (item) => item.id === rule.menuItemId,
                              )?.name ?? "позиция удалена"
                            }`
                          : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn btn-quiet btn-sm"
                        onClick={() => startEditUsageRule(rule)}
                        aria-label="Редактировать правило списания"
                        title="Редактировать правило"
                        data-testid={`button-edit-usage-rule-${rule.id}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="btn btn-quiet btn-sm btn-danger"
                        onClick={() => deleteUsageRule(rule.id)}
                        aria-label="Удалить правило списания"
                        title="Удалить правило"
                        data-testid={`button-remove-usage-rule-${rule.id}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">Правил списания пока нет.</div>
            )}
          </div>
      </div>
    </div>
  );
}
function SummaryRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 12,
      }}
    >
      <span style={{ color: "#92959b" }}>{label}</span>
      <b
        className="mono"
        style={{ color: highlight ? "#e5c466" : "#e2ded4", fontSize: 12 }}
      >
        {value}
      </b>
    </div>
  );
}
function calcStoredShiftPayroll(
  shift: Shift,
  menu: MenuItemWithBonus[],
  employees: Employee[],
  includeHelpers = true,
) {
  const payroll = calcPayrollByMenu(
    shift.master,
    shift.lines.map((line) => ({ menuItemId: line.menuItemId })),
    shift.fixedSalary,
    includeHelpers ? shift.helpersPay : 0,
    menu,
    employees,
  );
  // Доплата владельцу в смену больше не пишется: отдельные корректировки
  // учитываются через state.amidAdjustments (см. sumAmidAdjustments).
  return payroll;
}

function InventoryPage({ state, saveState, isAdmin, saving }: Shared) {
  const [tab, setTab] = useState<"stock" | "deliveries" | "tare" | "usage">("stock");
  // Период для колонки «Списано за период» и вкладки «Списания».
  const [usagePeriod, setUsagePeriod] = useState<"day" | "week" | "month">("day");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("tobacco");
  const [brand, setBrand] = useState("");
  const [packageGrams, setPackageGrams] = useState(100);
  const [stock, setStock] = useState(0);
  const [unit, setUnit] = useState("г");
  const [deliveryItem, setDeliveryItem] = useState("");
  const [deliveryQty, setDeliveryQty] = useState(1);
  const [coal, setCoal] = useState(state.coalOpeningKg);
  const [weighItem, setWeighItem] = useState(
    state.inventory.find((item) => categoryKind(item.category) === "tobacco")
      ?.id ?? "",
  );
  const [weighContainer, setWeighContainer] = useState(
    state.containers[0]?.id ?? "",
  );
  const [grossGrams, setGrossGrams] = useState(0);
  const [containerName, setContainerName] = useState("");
  const [tare, setTare] = useState(0);
  // Инлайн-редактирование строки остатков: активна только одна строка за раз.
  const [edit, setEdit] = useState<{
    id: string;
    name: string;
    category: string;
    brand: string;
    packageGrams: number;
    stock: number;
  } | null>(null);
  const mayAdd = isAdmin || state.permissions.addInventory;
  const mayCorrect = isAdmin || state.permissions.editPastInventory;
  // Коэффициенты списания берутся из настроек (state.usageSettings) — те же,
  // по которым сервер ведёт журнал списаний usageLog.
  const usage = resolveUsageSettings(state.usageSettings);
  const coalCurrent = state.inventory
    .filter((item) => categoryKind(item.category) === "coal")
    .reduce((sum, item) => sum + item.stock, 0);
  const coalUsed = state.shifts.reduce(
    (sum, shift) =>
      sum + calcCoalUsageKg(shift.lines.length, shift.rebuilds ?? 0, usage),
    0,
  );
  // Остаток табака: в граммах по всем позициям и в упаковках (по фасовке).
  const tobaccoCurrent = state.inventory
    .filter((item) => categoryKind(item.category) === "tobacco")
    .reduce((sum, item) => sum + item.stock, 0);
  const tobaccoPackages = state.inventory
    .filter(
      (item) => categoryKind(item.category) === "tobacco" && item.packageGrams > 0,
    )
    .reduce((sum, item) => sum + item.stock / item.packageGrams, 0);
  // Журнал списаний за выбранный период: записи создаёт сервер по закрытым
  // сменам и хранит формулу расчёта на момент списания.
  const usageRange = resolveReportRange(usagePeriod, localDate());
  const usageEntries = (state.usageLog ?? []).filter(
    (entry) => entry.date >= usageRange.from && entry.date <= usageRange.to,
  );
  const periodCoalKg = usageEntries.reduce((sum, entry) => sum + entry.coalKg, 0);
  const periodTobaccoGrams = usageEntries.reduce(
    (sum, entry) => sum + entry.tobaccoGrams,
    0,
  );
  const usagePeriodLabel =
    usagePeriod === "day" ? "день" : usagePeriod === "week" ? "неделя" : "месяц";
  /** Сколько сырья списано с этой позиции за выбранный период. */
  const itemWrittenOff = (item: InventoryItem): string => {
    let coalKg = 0;
    let tobaccoGrams = 0;
    for (const entry of usageEntries) {
      const part = (entry.items ?? []).find(
        (candidate) => candidate.inventoryId === item.id,
      );
      if (!part) continue;
      coalKg += part.coalKg;
      tobaccoGrams += part.tobaccoGrams;
    }
    if (categoryKind(item.category) === "coal") {
      return `${String(Math.round(coalKg * 1000) / 1000)} кг`;
    }
    if (categoryKind(item.category) === "tobacco") {
      return `${Math.round(tobaccoGrams)} г`;
    }
    return "—";
  };
  const periodPicker = (
    <div style={{ display: "flex", gap: 4 }}>
      {(
        [
          ["day", "День"],
          ["week", "Неделя"],
          ["month", "Месяц"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          className={`btn btn-sm ${usagePeriod === id ? "btn-primary" : ""}`}
          onClick={() => setUsagePeriod(id)}
          data-testid={`usage-period-${id}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const coalDeliveries = Math.max(
    0,
    coalCurrent + coalUsed - state.coalOpeningKg,
  );
  const createItem = () => {
    if (!name.trim() || saving) return;
    const item: InventoryItem = {
      id: uid(),
      name: name.trim(),
      category,
      brand,
      packageGrams,
      stock,
      unit,
    };
    saveState({ ...state, inventory: [...state.inventory, item] }, () => {
      setName("");
      setBrand("");
      setStock(0);
    });
  };
  const deleteItem = (id: string) =>
    saveState({
      ...state,
      inventory: state.inventory.filter((item) => item.id !== id),
    });
  // Инлайн-редактирование: карандаш переводит строку в режим правки всех
  // полей, галочка сохраняет. Вход разрешён по mayCorrect (как раньше), но
  // карточку (название/категория/бренд/фасовку) меняет только администратор —
  // сервер для работника отклоняет любые изменения кроме остатка.
  const startEdit = (item: InventoryItem) =>
    setEdit({
      id: item.id,
      name: item.name,
      category: item.category,
      brand: item.brand,
      packageGrams: item.packageGrams,
      stock: item.stock,
    });
  const cancelEdit = () => setEdit(null);
  const commitEdit = (item: InventoryItem) => {
    if (!edit || saving) return;
    const trimmedName = edit.name.trim();
    if (!trimmedName) return window.alert("Укажите наименование позиции.");
    if (!Number.isFinite(edit.packageGrams) || edit.packageGrams < 0)
      return window.alert("Фасовка должна быть числом от 0.");
    if (!Number.isFinite(edit.stock) || edit.stock < 0)
      return window.alert("Остаток должен быть числом от 0.");
    // Единица обновляется только при смене категории — по тому же канону, что и
    // в форме создания; иначе позиция сохраняет свою (например, «уп.»).
    const unit =
      categoryKind(edit.category) !== categoryKind(item.category)
        ? inventoryUnitForCategory(edit.category)
        : item.unit;
    saveState(
      {
        ...state,
        inventory: state.inventory.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                name: trimmedName,
                category: edit.category,
                brand: edit.brand.trim(),
                packageGrams: edit.packageGrams,
                stock: edit.stock,
                unit,
              }
            : entry,
        ),
      },
      () => setEdit(null),
    );
  };
  const recordDelivery = () => {
    if (!mayAdd || !deliveryItem || deliveryQty <= 0) return;
    saveState({
      ...state,
      inventory: state.inventory.map((item) =>
        item.id === deliveryItem
          ? { ...item, stock: item.stock + deliveryQty }
          : item,
      ),
    });
  };
  const recordWeighing = () => {
    const container = state.containers.find(
      (item) => item.id === weighContainer,
    );
    if (!mayCorrect || !container) return;
    const netGrams = Math.max(0, grossGrams - container.tareGrams);
    saveState({
      ...state,
      inventory: state.inventory.map((item) =>
        item.id === weighItem ? { ...item, stock: netGrams, unit: "г" } : item,
      ),
    });
  };
  const createContainer = () => {
    if (!containerName.trim() || saving) return;
    saveState(
      {
        ...state,
        containers: [
          ...state.containers,
          { id: uid(), name: containerName.trim(), tareGrams: tare },
        ],
      },
      () => {
        setContainerName("");
        setTare(0);
      },
    );
  };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Контроль остатков / склад</div>
          <h1>Запасы и поставки</h1>
          <div className="subhead">
            Остатки расходников, приёмка поставок и тара.
          </div>
        </div>
        <div className="tag gold">
          <Boxes size={13} style={{ marginRight: 6 }} />
          {state.inventory.length} позиций
        </div>
      </div>
      <div
        className="grid kpis"
        style={{
          gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
          marginBottom: 17,
        }}
      >
        <div className="card kpi">
          <div className="kpi-label">ПОЗИЦИЙ НА СКЛАДЕ</div>
          <div className="kpi-value">{state.inventory.length}</div>
          <div className="kpi-note">учитываются в остатках</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">ОСТАТОК УГЛЯ</div>
          <div className="kpi-value">{coalCurrent.toFixed(2)} кг</div>
          <div className="kpi-note">
            начало {state.coalOpeningKg.toFixed(2)} · приход{" "}
            {coalDeliveries.toFixed(2)} кг
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">ОСТАТОК ТАБАКА</div>
          <div className="kpi-value">{Math.round(tobaccoCurrent)} г</div>
          <div className="kpi-note">
            ≈ {tobaccoPackages.toFixed(1)} упаковок по фасовке
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">СПИСАНО ЗА ПЕРИОД</div>
          <div className="kpi-value">{periodCoalKg.toFixed(2)} кг</div>
          <div className="kpi-note">
            уголь · табак {Math.round(periodTobaccoGrams)} г · {usagePeriodLabel}
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">СПИСАНИЕ ЗА СМЕНЫ</div>
          <div className="kpi-value">{coalUsed.toFixed(2)} кг</div>
          <div className="kpi-note">
            {usage.coalKgPerHookah * 1000} г на кальян ·{" "}
            {usage.coalKgPerRebuild * 1000} г на перезабивку
          </div>
        </div>
      </div>
      <div className="card">
        <div
          style={{
            display: "flex",
            gap: 7,
            borderBottom: "1px solid #303239",
            margin: "-2px 0 20px",
            overflowX: "auto",
          }}
        >
          {(
            [
              ["stock", "Остатки"],
              ["deliveries", "Приёмка"],
              ["tare", "Тара"],
              ["usage", "Списания"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${tab === id ? "btn-primary" : ""}`}
              style={{
                borderRadius: "9px 9px 0 0",
                borderBottom: tab === id ? "2px solid #d4aa4c" : "",
              }}
              onClick={() => setTab(id)}
              data-testid={`tab-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "stock" && (
          <>
            <div className="section-title">
              <span>Текущий остаток</span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {periodPicker}
                {isAdmin && (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() =>
                      document
                        .getElementById("new-stock-item")
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                    data-testid="button-new-stock"
                  >
                    <Plus size={14} /> Новая позиция
                  </button>
                )}
              </div>
            </div>
            {!state.inventory.length ? (
              <div className="empty">
                Склад пока пуст. Добавьте первую позицию или внесите поставку.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Позиция</th>
                      <th>Категория</th>
                      <th>Бренд</th>
                      <th>Фасовка</th>
                      <th>Остаток</th>
                      <th title={`Списано за период: ${usageRange.from} — ${usageRange.to}`}>
                        Списано за период
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.inventory.map((item) => {
                      // Активна только одна строка за раз.
                      const editing = edit?.id === item.id ? edit : null;
                      const detailTitle = isAdmin
                        ? undefined
                        : "Карточку позиции редактирует администратор";
                      return (
                        <tr
                          key={item.id}
                          data-testid={`row-inventory-${item.id}`}
                        >
                          <td>
                            {editing ? (
                              <input
                                className="input"
                                style={EDIT_CELL_INPUT_STYLE}
                                value={editing.name}
                                disabled={!isAdmin}
                                onChange={(e) =>
                                  setEdit({ ...editing, name: e.target.value })
                                }
                                title={detailTitle}
                                aria-label="Позиция"
                                data-testid="input-edit-item-name"
                              />
                            ) : (
                              <b>{item.name}</b>
                            )}
                          </td>
                          <td>
                            {editing ? (
                              <select
                                className="select"
                                style={EDIT_CELL_INPUT_STYLE}
                                value={inventoryCategorySelectValue(
                                  editing.category,
                                )}
                                disabled={!isAdmin}
                                onChange={(e) =>
                                  setEdit({
                                    ...editing,
                                    category: e.target.value,
                                  })
                                }
                                title={detailTitle}
                                aria-label="Категория"
                                data-testid="select-edit-item-category"
                              >
                                <option value="tobacco">Табак</option>
                                <option value="coal">Уголь</option>
                                <option value="consumables">Расходники</option>
                                <option value="other">Прочее</option>
                              </select>
                            ) : categoryKind(item.category) === "coal" ? (
                              "Уголь"
                            ) : categoryKind(item.category) === "tobacco" ? (
                              "Табак"
                            ) : (
                              item.category
                            )}
                          </td>
                          <td>
                            {editing ? (
                              <input
                                className="input"
                                style={EDIT_CELL_INPUT_STYLE}
                                value={editing.brand}
                                disabled={!isAdmin}
                                onChange={(e) =>
                                  setEdit({ ...editing, brand: e.target.value })
                                }
                                placeholder="Марка"
                                title={detailTitle}
                                aria-label="Бренд"
                                data-testid="input-edit-item-brand"
                              />
                            ) : (
                              item.brand || "—"
                            )}
                          </td>
                          <td className="mono">
                            {editing ? (
                              <NumberField
                                className="input"
                                style={EDIT_CELL_INPUT_STYLE}
                                min="0"
                                value={editing.packageGrams}
                                disabled={!isAdmin}
                                onCommit={(next) =>
                                  setEdit({ ...editing, packageGrams: next })
                                }
                                title={detailTitle}
                                aria-label="Фасовка, г"
                                data-testid="input-edit-item-package-grams"
                              />
                            ) : (
                              `${item.packageGrams} г`
                            )}
                          </td>
                          <td>
                            {editing ? (
                              <NumberField
                                className="input"
                                style={EDIT_CELL_INPUT_STYLE}
                                min="0"
                                value={editing.stock}
                                onCommit={(next) =>
                                  setEdit({ ...editing, stock: next })
                                }
                                aria-label="Остаток"
                                data-testid="input-edit-item-stock"
                              />
                            ) : (
                              <span
                                className={`tag ${item.stock <= 2 ? "gold" : "green"}`}
                              >
                                {item.stock} {item.unit}
                              </span>
                            )}
                          </td>
                          <td
                            className="mono"
                            style={{ whiteSpace: "nowrap", fontSize: 11 }}
                            title={`Автоматическое списание за период (${usageRange.from} — ${usageRange.to})`}
                          >
                            {itemWrittenOff(item)}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {mayCorrect && !editing && (
                              <button
                                className="btn btn-quiet btn-sm"
                                onClick={() => startEdit(item)}
                                aria-label="Редактировать позицию"
                                title="Редактировать"
                                data-testid={`button-edit-item-${item.id}`}
                              >
                                <Pencil size={14} />
                              </button>
                            )}
                            {mayCorrect && editing && (
                              <>
                                <button
                                  className="btn btn-quiet btn-sm"
                                  disabled={saving}
                                  onClick={() => commitEdit(item)}
                                  aria-label="Сохранить"
                                  title="Сохранить"
                                  data-testid={`button-save-item-${item.id}`}
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  className="btn btn-quiet btn-sm"
                                  disabled={saving}
                                  onClick={cancelEdit}
                                  aria-label="Отмена"
                                  title="Отмена"
                                  data-testid={`button-cancel-item-${item.id}`}
                                >
                                  <X size={14} />
                                </button>
                              </>
                            )}
                            {isAdmin && !editing && (
                              <button
                                className="btn btn-quiet btn-sm btn-danger"
                                onClick={() => deleteItem(item.id)}
                                aria-label="Удалить"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {isAdmin && (
              <div id="new-stock-item">
                <div className="divider" />
                <div className="section-title">
                  <span>Новая складская позиция</span>
                  <Plus size={15} color="#d4aa4c" />
                </div>
                <div
                  className="grid"
                  style={{ gridTemplateColumns: "repeat(3,1fr)", gap: 11 }}
                >
                  <div>
                    <label className="label">Наименование</label>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Например, табак"
                      data-testid="input-item-name"
                    />
                  </div>
                  <div>
                    <label className="label">Категория</label>
                    <select
                      className="select"
                      value={category}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCategory(value);
                        setUnit(inventoryUnitForCategory(value));
                      }}
                    >
                      <option value="tobacco">Табак</option>
                      <option value="coal">Уголь</option>
                      <option value="consumables">Расходники</option>
                      <option value="other">Прочее</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Бренд</label>
                    <input
                      className="input"
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      placeholder="Марка"
                    />
                  </div>
                  <div>
                    <label className="label">Фасовка, г</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={packageGrams}
                      onCommit={setPackageGrams}
                      aria-label="Фасовка, грамм"
                    />
                  </div>
                  <div>
                    <label className="label">Остаток</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={stock}
                      onCommit={setStock}
                      aria-label="Остаток"
                    />
                  </div>
                  <div>
                    <label className="label">Единица</label>
                    <select
                      className="select"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                    >
                      <option>г</option>
                      <option>кг</option>
                      <option>уп.</option>
                      <option>шт.</option>
                      <option>кор.</option>
                    </select>
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 13 }}
                  onClick={createItem}
                  data-testid="button-create-inventory"
                >
                  <Plus size={14} /> Добавить на склад
                </button>
              </div>
            )}
          </>
        )}
        {tab === "deliveries" && (
          <>
            <div className="section-title">
              <span>Приход товара</span>
              <ArrowDownToLine size={16} color="#d4aa4c" />
            </div>
            {!mayAdd && (
              <div className="notice" style={{ marginBottom: 14 }}>
                Приёмку может вносить только сотрудник с соответствующим
                доступом.
              </div>
            )}
            <div
              className="grid"
              style={{
                gridTemplateColumns: "minmax(0,1fr) 130px auto",
                alignItems: "end",
                gap: 12,
              }}
            >
              <div>
                <label className="label">Позиция склада</label>
                <select
                  className="select"
                  value={deliveryItem}
                  onChange={(e) => setDeliveryItem(e.target.value)}
                >
                  <option value="">Выберите позицию</option>
                  {state.inventory.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · сейчас {i.stock} {i.unit}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">
                  Количество (
                  {state.inventory.find((i) => i.id === deliveryItem)?.unit ??
                    "ед."}
                  )
                </label>
                <NumberField
                  className="input"
                  min="0.001"
                  step="any"
                  value={deliveryQty}
                  onCommit={setDeliveryQty}
                  aria-label="Количество для приёмки"
                />
              </div>
              <button
                className="btn btn-primary"
                disabled={!mayAdd || !deliveryItem}
                onClick={recordDelivery}
                data-testid="button-record-delivery"
              >
                <Check size={15} /> Принять
              </button>
            </div>
            <div className="divider" />
            <div
              className="grid"
              style={{
                gridTemplateColumns: "1fr auto",
                alignItems: "end",
                gap: 12,
              }}
            >
              <div>
                <label className="label">Начальный остаток угля, кг</label>
                <NumberField
                  className="input"
                  min="0"
                  step=".1"
                  value={coal}
                  disabled={!mayCorrect}
                  onCommit={setCoal}
                  aria-label="Начальный остаток угля, кг"
                />
              </div>
              <button
                className="btn"
                disabled={!mayCorrect}
                onClick={() => saveState({ ...state, coalOpeningKg: coal })}
                data-testid="button-save-coal"
              >
                <Flame size={15} /> Сохранить остаток
              </button>
            </div>
          </>
        )}
        {tab === "tare" && (
          <>
            <div className="section-title">
              <span>Инвентаризация и тара</span>
              <span className="tag">{state.containers.length} ёмк.</span>
            </div>
            {state.inventory.some(
              (i) => categoryKind(i.category) === "tobacco",
            ) && state.containers.length > 0 ? (
              <>
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "1fr 1fr 150px auto",
                    alignItems: "end",
                    gap: 12,
                  }}
                >
                  <div>
                    <label className="label">Табак</label>
                    <select
                      className="select"
                      value={weighItem}
                      onChange={(e) => setWeighItem(e.target.value)}
                    >
                      {state.inventory
                        .filter((i) => categoryKind(i.category) === "tobacco")
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Тара</label>
                    <select
                      className="select"
                      value={weighContainer}
                      onChange={(e) => setWeighContainer(e.target.value)}
                    >
                      {state.containers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.tareGrams} г
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Вес брутто, г</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={grossGrams}
                      onCommit={setGrossGrams}
                      aria-label="Вес брутто, грамм"
                    />
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={
                      !mayCorrect ||
                      grossGrams <
                        (state.containers.find((c) => c.id === weighContainer)
                          ?.tareGrams ?? 0)
                    }
                    onClick={recordWeighing}
                    data-testid="button-weigh-tobacco"
                  >
                    <Check size={15} /> Переучесть
                  </button>
                </div>
                <p className="subhead">
                  Чистый вес:{" "}
                  {Math.max(
                    0,
                    grossGrams -
                      (state.containers.find((c) => c.id === weighContainer)
                        ?.tareGrams ?? 0),
                  )}{" "}
                  г (брутто минус тара).
                </p>
              </>
            ) : (
              <div className="empty">
                Добавьте складскую позицию табака и ёмкость, чтобы выполнить
                взвешивание.
              </div>
            )}
            {state.containers.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ёмкость</th>
                      <th>Вес тары</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.containers.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="mono">{c.tareGrams} г</td>
                        <td>
                          {isAdmin && (
                            <button
                              className="btn btn-quiet btn-sm"
                              aria-label="Удалить тару"
                              onClick={() =>
                                saveState({
                                  ...state,
                                  containers: state.containers.filter(
                                    (x) => x.id !== c.id,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isAdmin && (
              <>
                <div className="divider" />
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "1fr 160px auto",
                    alignItems: "end",
                    gap: 12,
                  }}
                >
                  <div>
                    <label className="label">Название ёмкости</label>
                    <input
                      className="input"
                      value={containerName}
                      onChange={(e) => setContainerName(e.target.value)}
                      placeholder="Например, банка 1 л"
                    />
                  </div>
                  <div>
                    <label className="label">Вес тары, г</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={tare}
                      onCommit={setTare}
                      aria-label="Вес тары, грамм"
                    />
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={createContainer}
                    data-testid="button-add-container"
                  >
                    <Plus size={14} /> Добавить
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {tab === "usage" && (
          <>
            <div className="section-title">
              <span>Списания сырья за период</span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {periodPicker}
                <span className="tag">{usageEntries.length} записей</span>
              </div>
            </div>
            <div className="notice" style={{ marginBottom: 12 }}>
              Каждая закрытая смена списывает сырьё по формулам из настроек и
              попадает в журнал: уголь — {usage.coalKgPerHookah} кг на кальян и{" "}
              {usage.coalKgPerRebuild} кг на перезабивку, табак — по норме чаши
              и {usage.tobaccoGramsPerRebuild} г на перезабивку.
            </div>
            {!usageEntries.length ? (
              <div className="empty">
                За выбранный период списаний нет — журнал заполняется при
                закрытии смен.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Смена</th>
                      <th>Кальянов</th>
                      <th>Перезабивок</th>
                      <th>Уголь</th>
                      <th>Табак</th>
                      <th>Формула расчёта</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageEntries.map((entry) => {
                      const shift = state.shifts.find(
                        (candidate) => candidate.id === entry.shiftId,
                      );
                      return (
                        <tr key={entry.id} data-testid={`row-usage-${entry.id}`}>
                          <td>
                            <b>{ruDate(entry.date)}</b>
                            <div
                              style={{
                                fontSize: 10,
                                color: "#81858b",
                                marginTop: 3,
                              }}
                            >
                              {shift?.master ?? "смена удалена из журнала"}
                            </div>
                          </td>
                          <td className="mono">{entry.hookahCount}</td>
                          <td className="mono">{entry.rebuildCount}</td>
                          <td className="mono">
                            {entry.coalKg.toFixed(3)} кг
                          </td>
                          <td className="mono">
                            {Math.round(entry.tobaccoGrams)} г
                          </td>
                          <td
                            style={{
                              fontSize: 10,
                              color: "#81858b",
                              lineHeight: 1.6,
                              minWidth: 220,
                            }}
                          >
                            <div>Уголь: {entry.coalFormula}</div>
                            <div>Табак: {entry.tobaccoFormula}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type Period = "day" | "week" | "month";
function ReportsPage({ state, isAdmin, canRevenue, saveState }: Shared) {
  const employees = getEmployees(state.employees);
  // Коэффициенты списания из настроек — для расхода за период и правки смен.
  const usage = resolveUsageSettings(state.usageSettings);
  const [period, setPeriod] = useState<Period>("week");
  const [selectedDate, setSelectedDate] = useState(localDate());
  // Пустые значения = автоматический диапазон недели (7 дней до выбранной даты).
  const [weekFrom, setWeekFrom] = useState("");
  const [weekTo, setWeekTo] = useState("");
  const [editing, setEditing] = useState<Shift | null>(null);
  const range = resolveReportRange(period, selectedDate, weekFrom, weekTo);
  const filtered = state.shifts.filter(
    (shift) => shift.date >= range.from && shift.date <= range.to,
  );
  const totalHooks = filtered.reduce((n, s) => n + s.lines.length, 0);
  const revenue = filtered.reduce(
    (n, s) =>
      n + s.lines.reduce((m, l) => m + saleAmount(l.unitPrice, l.discount), 0),
    0,
  );
  // Отдельные корректировки Амиду не привязаны к сменам, но входят в ФОТ.
  const amidAdjustmentsInRangeList = filterAmidAdjustmentsInRange(
    state.amidAdjustments,
    range.from,
    range.to,
  );
  const amidAdjustmentsTotal = sumAmidAdjustments(
    state.amidAdjustments,
    range.from,
    range.to,
  );
  const payrolls =
    filtered.reduce(
      (n, s) =>
        n + calcStoredShiftPayroll(s, state.menu as MenuItemWithBonus[], employees),
      0,
    ) + amidAdjustmentsTotal;
  const procurementTotal = filtered.reduce((sum, shift) => sum + (shift.purchaseAmount ?? 0), 0);
  const rebuildsTotal = filtered.reduce((n, s) => n + (s.rebuilds ?? 0), 0);
  const tobaccoUsed = filtered.reduce(
    (n, s) => n + calcTobaccoUsageGrams(s.lines, s.rebuilds ?? 0, usage),
    0,
  );
  const helpersTotal = filtered.reduce((n, s) => n + s.helpersPay, 0);
  const discounts = filtered.flatMap((s) =>
    s.lines.filter((l) => l.discount > 0).map((l) => ({ shift: s, line: l })),
  );
  const cats = [
    ...new Set(
      filtered.flatMap((s) => s.lines.map((line) => line.menuItemName)),
    ),
  ]
    .map((name) => ({
      name,
      count: filtered.reduce(
        (n, s) => n + s.lines.filter((l) => l.menuItemName === name).length,
        0,
      ),
    }))
    .filter((x) => x.count);
  const spanText = `${ruDate(range.from)} — ${ruDate(range.to)}`;
  // Владелец попадает в расчёт по мастерам, даже если сам не стоял в смене:
  // за ним могут числиться отдельные корректировки из amidAdjustments.
  const reportMasterNames = (() => {
    const names = uniqueMasters(filtered);
    if (amidAdjustmentsTotal > 0 && !names.includes(SHIFT_BONUS_OWNER_NAME)) {
      names.push(SHIFT_BONUS_OWNER_NAME);
    }
    return names;
  })();
  const mayEdit = isAdmin || state.permissions.editPastShifts;
  const removeShift = (id: string) => {
    const previous = state.shifts.find((s) => s.id === id);
    if (!previous || !window.confirm("Удалить запись смены?")) return;
    const inventory = adjustForShiftChange(state.inventory, previous, null, {
      usage,
      rules: state.usageRules,
    });
    if (!inventory) {
      window.alert("Не удалось восстановить остатки по этой смене.");
      return;
    }
    saveState({
      ...state,
      inventory,
      shifts: state.shifts.filter((s) => s.id !== id),
    });
  };
  const updateShift = (s: Shift) => {
    const previous = state.shifts.find((old) => old.id === s.id);
    if (!previous) return;
    const inventory = adjustForShiftChange(state.inventory, previous, s, {
      usage,
      rules: state.usageRules,
    });
    if (!inventory) {
      window.alert("Недостаточно остатков для изменений этой смены.");
      return;
    }
    saveState(
      {
        ...state,
        inventory,
        shifts: state.shifts.map((x) => (x.id === s.id ? s : x)),
      },
      () => setEditing(null),
    );
  };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Сводка / история</div>
          <h1>Отчёты</h1>
          <div className="subhead">
            Сверка выручки, загрузки и расчётов команды.
          </div>
        </div>
        <div className="tag">
          <TrendingUp size={13} style={{ marginRight: 6 }} />
          Период: {spanText}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 7,
          alignItems: "center",
          marginBottom: 17,
          flexWrap: "wrap",
        }}
      >
        {(
          [
            ["day", "День"],
            ["week", "Неделя"],
            ["month", "Месяц"],
          ] as [Period, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={`btn btn-sm ${period === id ? "btn-primary" : ""}`}
            onClick={() => setPeriod(id)}
            data-testid={`button-period-${id}`}
          >
            {label}
          </button>
        ))}
        {period === "week" ? (
          <div
            style={{
              display: "flex",
              gap: 7,
              alignItems: "center",
              marginLeft: "auto",
              flexWrap: "wrap",
            }}
          >
            <span className="label" style={{ margin: 0 }}>
              Свой период
            </span>
            <input
              aria-label="Начало периода"
              className="input"
              style={{ width: 158 }}
              type="date"
              value={range.from}
              onChange={(e) => setWeekFrom(e.target.value)}
              data-testid="input-report-from"
            />
            <span className="label" style={{ margin: 0 }}>
              —
            </span>
            <input
              aria-label="Конец периода"
              className="input"
              style={{ width: 158 }}
              type="date"
              value={range.to}
              onChange={(e) => setWeekTo(e.target.value)}
              data-testid="input-report-to"
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                setWeekFrom("");
                setWeekTo("");
                setSelectedDate(localDate());
              }}
              title="Вернуть последние 7 дней"
              data-testid="button-reset-range"
            >
              <RotateCcw size={14} /> Сбросить
            </button>
          </div>
        ) : (
          <input
            aria-label="Дата отчёта"
            className="input"
            style={{ width: 165, marginLeft: "auto" }}
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            data-testid="input-report-date"
          />
        )}
      </div>
      <div
        className="grid kpis"
        style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", marginBottom: 17 }}
      >
        {canRevenue ? (
          <div className="card kpi">
            <div className="kpi-label">ВЫРУЧКА</div>
            <div className="kpi-value">{rub(revenue)}</div>
            <div className="kpi-note">за выбранный период</div>
          </div>
        ) : (
          <div className="card kpi">
            <div className="kpi-label">ВЫРУЧКА</div>
            <div className="kpi-value" style={{ fontSize: 20 }}>
              Скрыта
            </div>
            <div className="kpi-note">нет разрешения на просмотр</div>
          </div>
        )}
        {canRevenue && (
          <div className="card kpi">
            <div className="kpi-label">ЗАКУПКИ</div>
            <div className="kpi-value">
              {revenue ? `${((procurementTotal / revenue) * 100).toFixed(1)}%` : "—"}
            </div>
            <div className="kpi-note">
              от выручки · {rub(procurementTotal)}
            </div>
          </div>
        )}
        <div className="card kpi">
          <div className="kpi-label">КАЛЬЯНЫ</div>
          <div className="kpi-value">{totalHooks}</div>
          <div className="kpi-note">всего · перезабивок {rebuildsTotal}</div>
        </div>
        {canRevenue ? (
          <div className="card kpi">
            <div className="kpi-label">ФОТ</div>
            <div className="kpi-value">
              {revenue ? `${((payrolls / revenue) * 100).toFixed(1)}%` : "—"}
            </div>
            <div className="kpi-note">
              доля от выручки · {rub(payrolls)}
            </div>
          </div>
        ) : (
          <div className="card kpi">
            <div className="kpi-label">СМЕНЫ</div>
            <div className="kpi-value">{filtered.length}</div>
            <div className="kpi-note">закрыто за период</div>
          </div>
        )}
        <div className="card kpi">
          <div className="kpi-label">РАСХОД ТАБАКА</div>
          <div className="kpi-value">{tobaccoUsed} г</div>
          <div className="kpi-note">
            Уголь:{" "}
            {filtered
              .reduce(
                (n, s) => n + calcCoalUsageKg(s.lines.length, s.rebuilds ?? 0, usage),
                0,
              )
              .toFixed(2)}{" "}
            кг
          </div>
        </div>
      </div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0,1.05fr) minmax(0,.95fr)",
          alignItems: "start",
        }}
      >
        <div className="card">
          <div className="section-title">
            <span>Категории кальянов</span>
            <span className="tag">
              {cats.reduce((n, c) => n + c.count, 0)} шт.
            </span>
          </div>
          {cats.length ? (
            <div style={{ display: "grid", gap: 16 }}>
              {cats.map((cat, i) => (
                <div key={cat.name}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      marginBottom: 7,
                    }}
                  >
                    <span>{cat.name}</span>
                    <b className="mono">
                      {cat.count} ·{" "}
                      {totalHooks
                        ? Math.round((cat.count / totalHooks) * 100)
                        : 0}
                      %
                    </b>
                  </div>
                  <div
                    style={{
                      height: 5,
                      background: "#303239",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        height: 5,
                        width: `${totalHooks ? (cat.count / totalHooks) * 100 : 0}%`,
                        borderRadius: 8,
                        background: [
                          "#d2aa50",
                          "#5e9d89",
                          "#b2785d",
                          "#748ead",
                        ][i % 4],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">В периоде пока нет продаж.</div>
          )}
          {canRevenue && (
            <>
              <div className="divider" />
              <div className="section-title">
                <span>Расчёт по мастерам</span>
              </div>
              {reportMasterNames.map((m) => {
                const rows = filtered.filter((s) => getShiftMembers(s.master).includes(m));
                const adjustmentCount =
                  m === SHIFT_BONUS_OWNER_NAME ? amidAdjustmentsInRangeList.length : 0;
                const earned =
                  rows.reduce(
                    (n, s) => n + payrollForMaster(s, m, state.menu as MenuItemWithBonus[], employees),
                    0,
                  ) + (m === SHIFT_BONUS_OWNER_NAME ? amidAdjustmentsTotal : 0);
                return (
                  <div
                    key={m}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "9px 0",
                      borderBottom: "1px solid #2b2d32",
                      fontSize: 12,
                    }}
                  >
                    <span>
                      {m}
                      <span style={{ color: "#777b81", marginLeft: 8 }}>
                        {rows.length} смен
                        {adjustmentCount > 0
                          ? ` · ${adjustmentCount} отдельных доплат`
                          : ""}
                      </span>
                    </span>
                    <b className="mono" style={{ color: "#ddc16f" }}>
                      {rub(earned)}{" "}
                      <small style={{ color: "#81858b" }}>
                        ·{" "}
                        {revenue
                          ? ((earned / revenue) * 100).toFixed(1)
                          : "0.0"}
                        %
                      </small>
                    </b>
                  </div>
                );
              })}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "9px 0",
                  fontSize: 12,
                }}
              >
                <span>Доп. выплаты помощникам</span>
                <b className="mono">{rub(helpersTotal)}</b>
              </div>
            </>
          )}
        </div>
        <div className="card">
          <div className="section-title">
            <span>Скидки и причины</span>
            <span className="tag">{discounts.length} случаев</span>
          </div>
          {discounts.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Смена</th>
                    <th>Позиция</th>
                    <th>Скидка</th>
                    <th>Причина</th>
                  </tr>
                </thead>
                <tbody>
                  {discounts.map(({ shift, line }) => (
                    <tr key={line.id}>
                      <td>{ruDate(shift.date)}</td>
                      <td>{line.menuItemName}</td>
                      <td className="mono">
                        {line.discount}% · −
                        {rub((line.unitPrice * line.discount) / 100)}
                      </td>
                      <td>{line.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">В выбранном периоде скидок нет.</div>
          )}
        </div>
      </div>
      <div className="card" style={{ marginTop: 17 }}>
        <div className="section-title">
          <span>История смен</span>
          <span className="tag">{filtered.length} записей</span>
        </div>
        {filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Мастер</th>
                  <th>Кальяны</th>
                  {canRevenue && (
                    <>
                      <th>Выручка</th>
                      <th>Начислено</th>
                      <th>Закупки</th>
                    </>
                  )}
                  <th>Комментарий</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const rev = s.lines.reduce(
                    (n, l) => n + saleAmount(l.unitPrice, l.discount),
                    0,
                  );
                  const pay = calcStoredShiftPayroll(s, state.menu as MenuItemWithBonus[], employees);
                  return (
                    <tr key={s.id} data-testid={`row-shift-${s.id}`}>
                      <td>{ruDate(s.date)}</td>
                      <td>{s.master}</td>
                      <td className="mono">{s.lines.length}</td>
                      {canRevenue && (
                        <>
                          <td className="mono">{rub(rev)}</td>
                          <td className="mono">{rub(pay)}</td>
                          <td className="mono">{rub(s.purchaseAmount ?? 0)}</td>
                        </>
                      )}
                      <td>{s.comment || "—"}</td>
                      <td>
                        {mayEdit && (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              className="btn btn-quiet btn-sm"
                              title="Изменить запись"
                              onClick={() => setEditing(s)}
                              data-testid={`button-edit-shift-${s.id}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="btn btn-quiet btn-sm btn-danger"
                              title="Удалить запись"
                              onClick={() => removeShift(s.id)}
                              data-testid={`button-delete-shift-${s.id}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            Нет смен за выбранный период. Новые записи появятся после сохранения
            смены.
          </div>
        )}
      </div>
      {editing && (
        <EditShift
          shift={editing}
          employees={getEmployees(state.employees)}
          canEditPurchase={canRevenue}
          onClose={() => setEditing(null)}
          onSave={updateShift}
        />
      )}
    </div>
  );
}
function uniqueMasters(shifts: Shift[]) {
  return [...new Set(shifts.flatMap((s) => s.master.split(/\s*[+/]\s*/)))];
}
function payrollForMaster(
  shift: Shift,
  master: string,
  menu: MenuItemWithBonus[],
  employees: Employee[],
) {
  // Процент в совместной смене делится поровну между участниками, оклад у
  // каждого свой — логика живёт в calcMasterShiftPayout и покрыта тестами.
  // Отдельные корректировки владельцу (amidAdjustments) сюда не входят.
  return calcMasterShiftPayout(
    shift,
    master,
    shift.lines.map((line) => ({ menuItemId: line.menuItemId })),
    menu,
    employees,
  );
}
function EditShift({ shift, employees, canEditPurchase, onClose, onSave }: { shift: Shift; employees: Employee[]; canEditPurchase: boolean; onClose: () => void; onSave: (s: Shift) => void }) {
  const [date, setDate] = useState(shift.date);
  const [selectedEmployees, setSelectedEmployees] = useState(() => getShiftMembers(shift.master));
  const [comment, setComment] = useState(shift.comment);
  const [fixed, setFixed] = useState<number | "">(shift.fixedSalary ?? "");
  const [purchaseAmount, setPurchaseAmount] = useState(shift.purchaseAmount ?? 0);
  const master = selectedEmployees.join(" + ");
  const toggleEmployee = (name: string) => setSelectedEmployees((current) => {
    if (current.includes(name)) return current.length > 1 ? current.filter((employee) => employee !== name) : current;
    return [...current, name];
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "#090a0bc9", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card" style={{ width: "min(100%,480px)" }}>
        <div className="section-title"><span>Изменить смену</span><button className="btn btn-quiet btn-sm" onClick={onClose}><X size={16} /></button></div>
        <label className="label">Дата</label>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label className="label" style={{ marginTop: 12 }}>Сотрудники</label>
        <div className="employee-picker" role="group" aria-label="Сотрудники смены">
          {employees.map((employee) => (
            <label key={employee.id} className={`employee-option ${selectedEmployees.includes(employee.name) ? "selected" : ""}`}>
              <input type="checkbox" checked={selectedEmployees.includes(employee.name)} onChange={() => toggleEmployee(employee.name)} aria-label={employee.name} />
              <span>{employee.name}</span>
            </label>
          ))}
        </div>
        {selectedEmployees.length === 1 && <><label className="label" style={{ marginTop: 12 }}>Оклад этой смены, ₽</label><input className="input" type="number" min="0" value={fixed} onChange={(e) => setFixed(e.target.value === "" ? "" : Number(e.target.value))} /></>}
        {canEditPurchase && <><label className="label" style={{ marginTop: 12 }}>Закупка, ₽</label><NumberField className="input" min="0" step="1" value={purchaseAmount} onCommit={(next) => setPurchaseAmount(Math.max(0, next))} data-testid="input-edit-purchase-amount" /></>}
        <label className="label" style={{ marginTop: 12 }}>Комментарий</label>
        <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={() => onSave({ ...shift, date, master, comment, fixedSalary: fixed === "" ? null : Number(fixed), purchaseAmount })}><Check size={14} /> Сохранить</button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({ state, saveState, isAdmin, saving, saveError }: Shared) {
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState(2000);
  const [newGrams, setNewGrams] = useState(27);
  const [newSalaryBonus, setNewSalaryBonus] = useState(0);
  const [menuDraft, setMenuDraft] = useState(withSpreadsheetMenuItems(state.menu));
  const [employeeDraft, setEmployeeDraft] = useState<Employee[]>(getEmployees(state.employees));
  const [newEmployeeName, setNewEmployeeName] = useState("");
  const [newEmployeeSalary, setNewEmployeeSalary] = useState(0);
  const [newEmployeeHighVolumeSalary, setNewEmployeeHighVolumeSalary] = useState(0);
  // Смена ключа сбрасывает черновик ввода в полях формы нового сотрудника.
  const [employeeFormKey, setEmployeeFormKey] = useState(0);
  // Черновик коэффициентов списания сырья: карточка «Расход сырья».
  const [usageDraft, setUsageDraft] = useState<UsageSettings>(() =>
    resolveUsageSettings(state.usageSettings),
  );
  useEffect(() => setMenuDraft(withSpreadsheetMenuItems(state.menu)), [JSON.stringify(state.menu)]);
  useEffect(() => setEmployeeDraft(getEmployees(state.employees)), [JSON.stringify(state.employees)]);
  useEffect(
    () => setUsageDraft(resolveUsageSettings(state.usageSettings)),
    [JSON.stringify(state.usageSettings ?? null)],
  );
  if (!isAdmin)
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="eyebrow">Управление доступом</div>
            <h1>Настройки</h1>
          </div>
        </div>
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice">
            Раздел доступен администратору. Для настройки меню и прав обратитесь
            к управляющему.
          </div>
        </div>
      </div>
    );
  const setPermission = (key: keyof typeof state.permissions, value: boolean) =>
    saveState({
      ...state,
      permissions: { ...state.permissions, [key]: value },
    });
  const setMenuAccess = (id: string, checked: boolean) =>
    saveState({
      ...state,
      permissions: {
        ...state.permissions,
        menuItemIds: checked
          ? [...state.permissions.menuItemIds, id]
          : state.permissions.menuItemIds.filter((x) => x !== id),
      },
    });
  // Сохранение коэффициентов списания: пишутся в БД через общий PUT /pos/state
  // и применяются ко всем новым операциям (смены, отчёты, журнал).
  const usageCurrent = resolveUsageSettings(state.usageSettings);
  const usageDirty = JSON.stringify(usageDraft) !== JSON.stringify(usageCurrent);
  const saveUsageSettings = () => {
    if (saving) return;
    const issue = validateUsageSettings(usageDraft);
    if (issue) return window.alert(issue);
    saveState({ ...state, usageSettings: usageDraft });
  };
  const updateItem = (id: string, patch: Partial<MenuItem>) =>
    setMenuDraft(menuDraft.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  // Общий путь сохранения меню: и кнопка «Сохранить меню», и быстрое добавление
  // «+» шлут один и тот же PUT /pos/state вместе с правами на новые позиции —
  // иначе новая позиция жила бы только в черновике и пропадала при уходе со
  // страницы (черновик восстанавливается из state.menu).
  const persistMenu = (items: MenuItem[], onSuccess?: () => void) => {
    const issues = validateMenuItems(items);
    if (issues.length) {
      window.alert(
        `Проверьте меню перед сохранением:\n${issues
          .map((issue) => formatMenuIssue(issue, items.find((item) => item.id === issue.itemId)?.name))
          .join("\n")}`,
      );
      return;
    }
    saveState(
      {
        ...state,
        menu: items,
        permissions: {
          ...state.permissions,
          menuItemIds: [
            ...state.permissions.menuItemIds.filter((id) => items.some((item) => item.id === id)),
            ...items
              .filter((item) => item.enabled && !state.menu.some((existing) => existing.id === item.id))
              .map((item) => item.id),
          ],
        },
      },
      onSuccess,
    );
  };
  const addItem = () => {
    const draft = {
      id: uid(),
      name: newName.trim(),
      price: Number(newPrice),
      tobaccoGrams: Number(newGrams),
      enabled: true,
      salaryBonus: Number(newSalaryBonus),
    };
    // Состояние сохраняется целиком: одна негодная позиция отклоняет запись
    // меню, склада и смен, поэтому проверяем новую позицию сразу.
    const issues = validateMenuItems([draft]);
    if (issues.length) {
      window.alert(`Позиция не добавлена: ${issues.map((issue) => issue.message).join("; ")}.`);
      return;
    }
    const nextMenu = [...menuDraft, draft];
    // Оптимистично показываем строку в списке, но сохраняем сразу: так позиция
    // попадает и в базу, и в плитки меню сотрудника без отдельного «Сохранить
    // меню». Поля формы очищаются только после успешного ответа сервера.
    setMenuDraft(nextMenu);
    persistMenu(nextMenu, () => {
      setNewName("");
      setNewPrice(2000);
      setNewGrams(27);
      setNewSalaryBonus(0);
    });
  };
  const removeItem = (id: string) => {
    if (
      window.confirm(
        "Удалить позицию меню? Существующие смены останутся в истории.",
      )
    )
      setMenuDraft(menuDraft.filter((m) => m.id !== id));
  };
  const menuDirty = JSON.stringify(menuDraft) !== JSON.stringify(state.menu);
  const menuIssues = validateMenuItems(menuDraft);
  const menuIssueLines = menuIssues.map((issue) =>
    formatMenuIssue(issue, menuDraft.find((item) => item.id === issue.itemId)?.name),
  );
  const menuIssuesById = new Map<string, string[]>();
  menuIssues.forEach((issue, index) => {
    const list = menuIssuesById.get(issue.itemId) ?? [];
    list.push(menuIssueLines[index]);
    menuIssuesById.set(issue.itemId, list);
  });
  const menuIssueSummary = `${menuIssueLines.slice(0, 3).join("; ")}${
    menuIssueLines.length > 3 ? ` и ещё ${menuIssueLines.length - 3}` : ""
  }`;
  const saveMenu = () => persistMenu(menuDraft);
  const updateEmployee = (id: string, patch: Partial<Employee>) =>
    setEmployeeDraft((draft) => draft.map((employee) => employee.id === id ? { ...employee, ...patch } : employee));
  const addEmployee = () => {
    const name = newEmployeeName.trim();
    if (!name || /[+/]/.test(name) || employeeDraft.some((employee) => employee.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) {
      window.alert("Укажите уникальное имя сотрудника без символов + и /.");
      return;
    }
    setEmployeeDraft((draft) => [...draft, {
      id: uid(),
      name,
      baseSalary: Math.max(0, Number(newEmployeeSalary)),
      highVolumeSalary: Math.max(0, Number(newEmployeeHighVolumeSalary)),
    }]);
    setNewEmployeeName("");
    setNewEmployeeSalary(0);
    setNewEmployeeHighVolumeSalary(0);
    setEmployeeFormKey((current) => current + 1);
  };
  const removeEmployee = (employee: Employee) => {
    if (employeeDraft.length <= 1) {
      window.alert("Нельзя удалить последнего сотрудника.");
      return;
    }
    if (state.shifts.some((shift) => shift.master.split(/\s*[+/]\s*/).includes(employee.name))) {
      window.alert("Нельзя удалить сотрудника, пока его смены есть в истории.");
      return;
    }
    setEmployeeDraft((draft) => draft.filter((entry) => entry.id !== employee.id));
  };
  const employeesDirty = JSON.stringify(employeeDraft) !== JSON.stringify(getEmployees(state.employees));
  const employeeNames = employeeDraft.map((employee) => employee.name.trim().toLocaleLowerCase("ru-RU"));
  const employeesValid = employeeDraft.every((employee) => employee.name.trim() && !/[+/]/.test(employee.name))
    && new Set(employeeNames).size === employeeNames.length;
  const saveEmployees = () => {
    if (!employeesValid) {
      window.alert("Имена сотрудников должны быть непустыми, уникальными и без символов + и /.");
      return;
    }
    const previousEmployees = getEmployees(state.employees);
    const employeesToSave = employeeDraft.map((employee) => ({ ...employee, name: employee.name.trim() }));
    const namesById = new Map(employeesToSave.map((employee) => [employee.id, employee.name]));
    const namesByPreviousName = new Map(previousEmployees.map((employee) => [
      employee.name,
      namesById.get(employee.id) ?? employee.name,
    ]));
    const shifts = state.shifts.map((shift) => ({
      ...shift,
      master: shift.master.split(/\s*[+/]\s*/).map((name) => namesByPreviousName.get(name) ?? name).join(" + "),
    }));
    saveState({ ...state, employees: employeesToSave, shifts });
  };
  const toggles: [keyof typeof state.permissions, string, string][] = [
    [
      "seeRevenue",
      "Просмотр выручки",
      "Разрешить сотрудникам видеть суммы продаж и зарплаты.",
    ],
    [
      "useDiscounts",
      "Скидки при вводе смены",
      "Сотрудники могут применить скидку 50% или 100% и указать причину.",
    ],
    [
      "addInventory",
      "Приёмка товара",
      "Разрешить вносить поставки. Каталог складских позиций меняет администратор.",
    ],
    [
      "editPastInventory",
      "Переучёт склада",
      "Разрешить исправление фактических остатков и начального баланса угля.",
    ],
    [
      "editPastShifts",
      "Правка истории смен",
      "Разрешить менять и удалять записи прошедших смен.",
    ],
  ];
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Администратор / конфигурация</div>
          <h1>Настройки терминала</h1>
          <div className="subhead">
            Меню продаж и доступ сотрудника к функциям.
          </div>
        </div>
        <div className="tag gold">
          <ShieldCheck size={14} style={{ marginRight: 6 }} />
          Полный доступ
        </div>
      </div>
      {saveError && (
        <div className="notice" style={{ marginBottom: 14, color: "#df897d" }} role="alert">
          Сервер не сохранил данные: {saveError}
        </div>
      )}
      <div className="card" style={{ marginBottom: 17 }}>
        <div className="section-title">
          <span>Расход сырья (автосписание)</span>
          <Flame size={16} color="#b99b58" />
        </div>
        <div className="notice" style={{ marginBottom: 14 }}>
          Коэффициенты хранятся в базе данных и применяются ко всем новым
          операциям сразу после сохранения: смены, отчёты и журнал списаний
          считают по ним. Уже закрытые смены сохраняют формулу, с которой были
          списаны.
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
            gap: 12,
          }}
        >
          <div>
            <label className="label">Уголь на кальян, кг</label>
            <NumberField
              className="input"
              min="0"
              step="0.001"
              value={usageDraft.coalKgPerHookah}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, coalKgPerHookah: next })
              }
              aria-label="Килограммов угля на кальян"
              data-testid="input-usage-coal-per-hookah"
              disabled={saving}
            />
          </div>
          <div>
            <label className="label">Уголь на перезабивку, кг</label>
            <NumberField
              className="input"
              min="0"
              step="0.001"
              value={usageDraft.coalKgPerRebuild}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, coalKgPerRebuild: next })
              }
              aria-label="Килограммов угля на перезабивку"
              data-testid="input-usage-coal-per-rebuild"
              disabled={saving}
            />
          </div>
          <div>
            <label className="label">Табак на забив/перезабивку, г</label>
            <NumberField
              className="input"
              min="0"
              step="1"
              value={usageDraft.tobaccoGramsPerRebuild}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, tobaccoGramsPerRebuild: next })
              }
              aria-label="Граммов табака на перезабивку"
              data-testid="input-usage-tobacco-per-rebuild"
              disabled={saving}
            />
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 10,
            marginTop: 14,
          }}
        >
          {usageDirty && <span className="saving">Есть несохранённые изменения</span>}
          <button
            className="btn btn-primary"
            onClick={saveUsageSettings}
            disabled={saving || !usageDirty}
            data-testid="button-save-usage-settings"
          >
            <Check size={14} /> {saving ? "Сохраняем…" : "Сохранить правила"}
          </button>
        </div>
      </div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(0,1.2fr) minmax(280px,.8fr)",
          alignItems: "start",
        }}
      >
        <div className="card">
          <div className="section-title">
            <span>Меню кальянов</span>
            <span className="tag">{menuDraft.length} позиций</span>
          </div>
          {!state.menu.some((item) => item.id === BARBIE_MENU_ITEM.id) && (
            <div className="notice" style={{ marginBottom: 12 }}>
              Из таблицы добавлена позиция «Барби». Укажите её цену и включите в меню перед сохранением.
            </div>
          )}
          {menuIssues.length > 0 && (
            <div className="notice" style={{ marginBottom: 12, color: "#df897d" }}>
              Позиции не сохранятся, пока не исправлено: {menuIssueSummary}.
            </div>
          )}
          {menuDraft.map((item) => (
            <Fragment key={item.id}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(100px,1fr) 92px 68px 82px 58px 28px",
                gap: 9,
                alignItems: "center",
                padding: "11px 0",
                borderBottom: "1px solid #2c2e33",
              }}
            >
              <input
                className="input"
                value={item.name}
                onChange={(e) => updateItem(item.id, { name: e.target.value })}
                aria-label="Название позиции"
                data-testid={`input-menu-name-${item.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={item.price}
                onCommit={(next) => updateItem(item.id, { price: next })}
                aria-label={`Цена позиции ${item.name}, рублей`}
                data-testid={`input-menu-price-${item.id}`}
                disabled={saving}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <NumberField
                  className="input"
                  min={MIN_TOBACCO_GRAMS}
                  max={MAX_TOBACCO_GRAMS}
                  step="1"
                  value={item.tobaccoGrams}
                  onCommit={(next) => updateItem(item.id, { tobaccoGrams: next })}
                  aria-label="Табак, грамм"
                  disabled={saving}
                />
                <small style={{ color: "#777" }}>г</small>
              </div>
              <NumberField
                className="input"
                min="0"
                value={item.salaryBonus ?? getMenuSalaryBonus(state.menu as MenuItemWithBonus[], item.id)}
                onCommit={(next) => updateItem(item.id, { salaryBonus: next })}
                aria-label={`Доплата за ${item.name}, рублей`}
                data-testid={`input-menu-salary-bonus-${item.id}`}
                disabled={saving}
              />
              <button
                className={`btn btn-sm ${item.enabled ? "" : "btn-quiet"}`}
                onClick={() => updateItem(item.id, { enabled: !item.enabled })}
                data-testid={`button-toggle-menu-${item.id}`}
                disabled={saving}
              >
                {item.enabled ? "В меню" : "Скрыта"}
              </button>
              <button
                className="btn btn-quiet btn-sm btn-danger"
                onClick={() => removeItem(item.id)}
                aria-label="Удалить позицию"
                disabled={saving}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {(menuIssuesById.get(item.id) ?? []).map((line) => (
              <div key={line} role="alert" style={{ color: "#df897d", fontSize: 11, padding: "0 0 8px" }}>
                {line}
              </div>
            ))}
            </Fragment>
          ))}
          <div className="divider" />
          <div className="section-title">
            <span>Добавить позицию</span>
            <Plus size={15} color="#d4aa4c" />
          </div>
          <div
            className="grid"
            style={{
              gridTemplateColumns: "1fr 115px 92px 105px auto",
              gap: 9,
              alignItems: "end",
            }}
          >
            <div>
              <label className="label">Название</label>
              <input
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Новинка"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">Цена</label>
              <NumberField
                className="input"
                min="0"
                step="1"
                value={newPrice}
                onCommit={setNewPrice}
                aria-label="Цена новой позиции, рублей"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">Табак, г ({MIN_TOBACCO_GRAMS}–{MAX_TOBACCO_GRAMS})</label>
              <NumberField
                className="input"
                min={MIN_TOBACCO_GRAMS}
                max={MAX_TOBACCO_GRAMS}
                step="1"
                value={newGrams}
                onCommit={setNewGrams}
                aria-label="Табак новой позиции, грамм"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">Доплата, ₽</label>
              <NumberField
                className="input"
                min="0"
                value={newSalaryBonus}
                onCommit={setNewSalaryBonus}
                aria-label="Доплата новой позиции, рублей"
                disabled={saving}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={addItem}
              data-testid="button-add-menu"
              disabled={saving}
            >
              <Plus size={14} />
            </button>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: 12,
            }}
          >
            <button
              className="btn btn-primary"
              onClick={saveMenu}
              disabled={saving || !menuDirty || menuIssues.length > 0}
              data-testid="button-save-menu"
            >
              <Check size={14} /> {saving ? "Сохраняем…" : "Сохранить меню"}
            </button>
          </div>
        </div>
        <div className="grid">
          <div className="card">
            <div className="section-title">
              <span>Права сотрудника</span>
              <Users size={16} color="#b99b58" />
            </div>
            <div className="notice" style={{ marginBottom: 14 }}>
              Настройки применяются к роли «Сотрудник» сразу после сохранения.
            </div>
            {toggles.map(([key, title, desc]) => (
              <label
                key={key}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid #2b2d32",
                  cursor: "pointer",
                }}
              >
                <span>
                  <b style={{ fontSize: 12 }}>{title}</b>
                  <span
                    style={{
                      display: "block",
                      fontSize: 10,
                      color: "#81858b",
                      marginTop: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {desc}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(state.permissions[key])}
                  onChange={(e) => setPermission(key, e.target.checked)}
                  data-testid={`toggle-permission-${key}`}
                  style={{
                    accentColor: "#d4aa4c",
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                  }}
                  disabled={saving}
                />
              </label>
            ))}
          </div>
          <div className="card">
            <div className="section-title">
              <span>Доступные позиции</span>
              <ChevronRight size={16} color="#858990" />
            </div>
            <p className="subhead" style={{ marginTop: -8, marginBottom: 14 }}>
              Что сотрудник увидит в интерфейсе ввода смены.
            </p>
            {menuDraft.map((item) => (
              <label
                key={item.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "9px 0",
                  borderBottom: "1px solid #2b2d32",
                  fontSize: 12,
                  alignItems: "center",
                }}
              >
                <span>
                  {item.name}
                  <small style={{ color: "#777b81", marginLeft: 7 }}>
                    {rub(item.price)}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={state.permissions.menuItemIds.includes(item.id)}
                  onChange={(e) => setMenuAccess(item.id, e.target.checked)}
                  data-testid={`toggle-menu-access-${item.id}`}
                  style={{ accentColor: "#d4aa4c", width: 17, height: 17 }}
                  disabled={saving}
                />
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 17 }}>
        <div className="section-title">
          <span>Сотрудники и зарплаты</span>
          <Users size={16} color="#b99b58" />
        </div>
        <p className="subhead" style={{ marginTop: -8, marginBottom: 14 }}>
          У каждого свой оклад за смену и ставка после 30 кальянов. Доплата меню делится поровну между выбранными сотрудниками.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) 36px", gap: 9, paddingBottom: 5 }}>
          <span className="label">Сотрудник</span>
          <span className="label">Оклад за смену, ₽</span>
          <span className="label">Свыше 30 кальянов, ₽</span>
          <span />
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {employeeDraft.map((employee) => (
            <div key={employee.id} style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) 36px", gap: 9, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #2b2d32" }}>
              <input
                className="input"
                value={employee.name}
                onChange={(e) => updateEmployee(employee.id, { name: e.target.value })}
                aria-label={`Имя сотрудника ${employee.name}`}
                data-testid={`input-employee-name-${employee.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={employee.baseSalary}
                onCommit={(next) => updateEmployee(employee.id, { baseSalary: Math.max(0, next) })}
                aria-label={`Оклад ${employee.name}, рублей`}
                data-testid={`input-employee-salary-${employee.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={employee.highVolumeSalary}
                onCommit={(next) => updateEmployee(employee.id, { highVolumeSalary: Math.max(0, next) })}
                aria-label={`Оклад ${employee.name} свыше 30 кальянов, рублей`}
                data-testid={`input-employee-high-salary-${employee.id}`}
                disabled={saving}
              />
              <button className="btn btn-quiet btn-sm btn-danger" onClick={() => removeEmployee(employee)} aria-label={`Удалить ${employee.name}`} disabled={saving}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) auto", gap: 9, alignItems: "end", marginTop: 13 }}>
          <div>
            <label className="label">Новый сотрудник</label>
            <input className="input" value={newEmployeeName} onChange={(e) => setNewEmployeeName(e.target.value)} placeholder="Имя" disabled={saving} />
          </div>
          <div>
            <label className="label">Оклад, ₽</label>
            <NumberField className="input" min="0" step="1" key={`new-salary-${employeeFormKey}`} value={newEmployeeSalary} disabled={saving} aria-label="Оклад нового сотрудника, рублей" onCommit={(salary) => {
              const next = Math.max(0, salary);
              setNewEmployeeSalary(next);
              setNewEmployeeHighVolumeSalary((current) => current === 0 ? next : current);
            }} />
          </div>
          <div>
            <label className="label">Свыше 30, ₽</label>
            <NumberField className="input" min="0" step="1" key={`new-high-${employeeFormKey}`} value={newEmployeeHighVolumeSalary} aria-label="Оклад нового сотрудника свыше 30 кальянов, рублей" onCommit={(next) => setNewEmployeeHighVolumeSalary(Math.max(0, next))} disabled={saving} />
          </div>
          <button className="btn btn-primary" onClick={addEmployee} aria-label="Добавить сотрудника" disabled={saving || !newEmployeeName.trim()}>
            <Plus size={14} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 13 }}>
          <button className="btn btn-primary" onClick={saveEmployees} disabled={saving || !employeesDirty || !employeesValid} data-testid="button-save-employees">
            <Check size={14} /> {saving ? "Сохраняем…" : "Сохранить сотрудников"}
          </button>
        </div>
      </div>
      <div className="card" style={{ marginTop: 17 }}>
        <div className="section-title">
          <span>Тарифы и расчёт</span>
          <Flame size={16} color="#b99b58" />
        </div>
        <p className="subhead" style={{ marginTop: -6, marginBottom: 12 }}>
          Цена, граммовка табака и доплата каждой позиции — правятся прямо здесь.
        </p>
        {menuDraft.length ? (
          <div style={{ display: "grid", gap: 4 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(110px,1fr) 96px 74px 92px",
                gap: 9,
                paddingBottom: 4,
              }}
            >
              <span className="label">Позиция</span>
              <span className="label">Цена, ₽</span>
              <span className="label">Табак, г</span>
              <span className="label">Доплата, ₽</span>
            </div>
            {menuDraft.map((item) => (
              <Fragment key={item.id}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(110px,1fr) 96px 74px 92px",
                    gap: 9,
                    alignItems: "center",
                    padding: "8px 0",
                    borderTop: "1px solid #2c2e33",
                  }}
                >
                  <input
                    className="input"
                    value={item.name}
                    onChange={(e) => updateItem(item.id, { name: e.target.value })}
                    aria-label={`Название позиции ${item.name}`}
                    data-testid={`input-tariff-name-${item.id}`}
                    disabled={saving}
                  />
                  <NumberField
                    className="input"
                    min="0"
                    step="1"
                    value={item.price}
                    onCommit={(next) => updateItem(item.id, { price: next })}
                    aria-label={`Цена позиции ${item.name}, рублей`}
                    data-testid={`input-tariff-price-${item.id}`}
                    disabled={saving}
                  />
                  <NumberField
                    className="input"
                    min={MIN_TOBACCO_GRAMS}
                    max={MAX_TOBACCO_GRAMS}
                    step="1"
                    value={item.tobaccoGrams}
                    onCommit={(next) => updateItem(item.id, { tobaccoGrams: next })}
                    aria-label={`Табак позиции ${item.name}, грамм`}
                    data-testid={`input-tariff-grams-${item.id}`}
                    disabled={saving}
                  />
                  <NumberField
                    className="input"
                    min="0"
                    value={item.salaryBonus ?? getMenuSalaryBonus(state.menu as MenuItemWithBonus[], item.id)}
                    onCommit={(next) => updateItem(item.id, { salaryBonus: next })}
                    aria-label={`Доплата за ${item.name}, рублей`}
                    data-testid={`input-tariff-bonus-${item.id}`}
                    disabled={saving}
                  />
                </div>
                {!item.enabled && (
                  <div style={{ color: "#8b8f96", fontSize: 10, paddingBottom: 6 }}>
                    Позиция скрыта из меню — включается в списке «Меню кальянов».
                  </div>
                )}
                {(menuIssuesById.get(item.id) ?? []).map((line) => (
                  <div key={line} role="alert" style={{ color: "#df897d", fontSize: 11, paddingBottom: 6 }}>
                    {line}
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="empty">Позиции меню пока не заданы.</div>
        )}
        <p className="subhead" style={{ fontSize: 11, lineHeight: 1.6 }}>
          Изменения применяются кнопкой «Сохранить меню». Итог смены = оклады
          мастеров + вся доплата за позиции + выплаты помощникам; оклад мастера и
          ставка свыше 30 кальянов — в разделе «Сотрудники и зарплаты».
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 10 }}>
          {menuDirty && <span className="saving">Есть несохранённые изменения</span>}
          <button
            className="btn btn-primary"
            onClick={saveMenu}
            disabled={saving || !menuDirty || menuIssues.length > 0}
            data-testid="button-save-menu-tariffs"
          >
            <Check size={14} /> {saving ? "Сохраняем…" : "Сохранить меню"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RootApp() { return <QueryClientProvider client={qc}><AppInner /></QueryClientProvider>; }
export default RootApp;

