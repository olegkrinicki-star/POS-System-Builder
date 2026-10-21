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
  name: 'Р‘Р°СЂР±Рё',
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
const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} в‚Ѕ`;
const localDate = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const saleAmount = (price: number, discount: number) => price * (1 - discount / 100);
const categoryKind = (value: string): 'coal' | 'tobacco' | 'other' => {
  const category = value.trim().toLocaleLowerCase('ru-RU');
  if (category === 'coal' || category === 'СѓРіРѕР»СЊ') return 'coal';
  if (category === 'tobacco' || category === 'С‚Р°Р±Р°Рє') return 'tobacco';
  return 'other';
};
/** РљРѕРјРїР°РєС‚РЅС‹Рµ РёРЅРїСѓС‚С‹ РІРЅСѓС‚СЂРё СЏС‡РµРµРє С‚Р°Р±Р»РёС†С‹ РѕСЃС‚Р°С‚РєРѕРІ (РѕР±С‰РёРµ .input СЃР»РёС€РєРѕРј РІС‹СЃРѕРєРёРµ). */
const EDIT_CELL_INPUT_STYLE = { padding: '8px 10px', fontSize: 12 };

/** РћР±С‰РёР№ РєРѕРЅС‚РµРєСЃС‚ СЂР°СЃС‡С‘С‚Р° СЂР°СЃС…РѕРґР°: РЅР°СЃС‚СЂРѕР№РєРё + РїСЂР°РІРёР»Р° РєРѕРЅСЃС‚СЂСѓРєС‚РѕСЂР°. */
type UsageContext = { usage?: Partial<UsageSettings> | null; rules?: UsageRule[] | null };

/** Р Р°СЃС…РѕРґ СЃРјРµРЅС‹ РїРѕ РєР°С‚РµРіРѕСЂРёСЏРј СЃРєР»Р°РґР° вЂ” СЃРєР°РЅРёСЂСѓРµС‚ Р±Р°Р·Сѓ Рё РїСЂР°РІРёР»Р° Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°. */
function shiftUsageCategories(
  shift: Shift,
  inventory: InventoryItem[],
  ctx: UsageContext,
): Record<string, number> {
  return evalShiftUsage(shift, inventory, ctx.usage, ctx.rules).byCategory;
}

/** РЎРїРёСЃР°С‚СЊ СЃСѓРјРјСѓ СЃ РїРѕР·РёС†РёР№ РєР°С‚РµРіРѕСЂРёРё РІ РїРѕСЂСЏРґРєРµ РєР°С‚Р°Р»РѕРіР° (null вЂ” РЅРµ С…РІР°С‚РёР»Рѕ). */
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

/** Р’РµСЂРЅСѓС‚СЊ СѓРјРµРЅСЊС€РёРІС€РёР№СЃСЏ СЂР°СЃС…РѕРґ РЅР° РїРµСЂРІСѓСЋ РїРѕР·РёС†РёСЋ РєР°С‚РµРіРѕСЂРёРё. */
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
 * РџСЂР°РІРєР°/СѓРґР°Р»РµРЅРёРµ РїСЂРѕС€Р»РѕР№ СЃРјРµРЅС‹: СЂР°Р·РЅРёС†Р° СЂР°СЃС…РѕРґР° СЃС‚Р°СЂРѕР№ Рё РЅРѕРІРѕР№ РІРµСЂСЃРёРё
 * РІРѕР·РІСЂР°С‰Р°РµС‚СЃСЏ РЅР° СЃРєР»Р°Рґ РёР»Рё СЃРїРёСЃС‹РІР°РµС‚СЃСЏ вЂ” РїРѕ РІСЃРµРј РєР°С‚РµРіРѕСЂРёСЏРј, Р·Р°С‚СЂРѕРЅСѓС‚С‹Рј
 * Р±Р°Р·РѕРІС‹РјРё РєРѕСЌС„С„РёС†РёРµРЅС‚Р°РјРё Рё РїСЂР°РІРёР»Р°РјРё.
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
    { id: 'classic', name: 'РљР»Р°СЃСЃРёРєР°', price: 1500, tobaccoGrams: 24, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.classic },
    { id: 'grapefruit', name: 'Р“СЂРµР№РїС„СЂСѓС‚', price: 2000, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.grapefruit },
    { id: 'pineapple', name: 'РђРЅР°РЅР°СЃ', price: 2500, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.pineapple },
    { ...BARBIE_MENU_ITEM },
    { id: 'signature', name: 'РђРІС‚РѕСЂСЃРєРёР№', price: 3600, tobaccoGrams: 27, enabled: true, salaryBonus: DEFAULT_MENU_SALARY_BONUSES.signature },
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
  if (sessionQuery.isError) return <QueryError title="РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРІРµСЂРёС‚СЊ РІС…РѕРґ" retry={() => sessionQuery.refetch()} />;
  if (!loggedIn) return <LoginScreen pending={login.isPending} error={login.error} onLogin={(pin) => login.mutate({ data: { pin } }, { onSuccess: (s) => { queryClient.setQueryData(['/api/pos/session'], s); sessionQuery.refetch(); } })} />;
  if (stateQuery.isError) return <Shell role={role} logout={() => logout.mutate(undefined)}><QueryError title="РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РґР°РЅРЅС‹Рµ СЃРјРµРЅС‹" retry={() => stateQuery.refetch()} /></Shell>;
  if (isStateLoading || !state) return <Shell role={role} logout={() => logout.mutate(undefined, { onSuccess: () => { setState(null); queryClient.setQueryData(['/api/pos/session'], { authenticated: false, role: null }); sessionQuery.refetch(); setLocation('/'); } })}><LoadingScreen inline /></Shell>;
  if (!state) return <LoadingScreen />;

  // РљРѕР»Р±СЌРє РѕР±СЏР·Р°С‚РµР»РµРЅ: СЃС‚СЂР°РЅРёС†С‹ СЃР±СЂР°СЃС‹РІР°СЋС‚ С„РѕСЂРјСѓ Рё РІС‹С…РѕРґСЏС‚ РёР· СЂРµР¶РёРјР°
  // СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёСЏ С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ СѓСЃРїРµС€РЅРѕРіРѕ РѕС‚РІРµС‚Р° СЃРµСЂРІРµСЂР°.
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
  return <div className="page"><div className="card" style={{ maxWidth: 520, margin: '8vh auto', textAlign: 'center' }}><div className="eyebrow">РЎРІСЏР·СЊ СЃ С‚РµСЂРјРёРЅР°Р»РѕРј</div><h2 style={{ margin: '0 0 10px' }}>{title}</h2><p className="subhead">РџСЂРѕРІРµСЂСЊС‚Рµ СЃРѕРµРґРёРЅРµРЅРёРµ Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·. Р—Р°РїРёСЃРё РЅРµ Р±СѓРґСѓС‚ РїРѕС‚РµСЂСЏРЅС‹.</p><button className="btn btn-primary" onClick={retry} data-testid="button-retry"><RotateCcw size={15} /> РџРѕРІС‚РѕСЂРёС‚СЊ</button></div></div>;
}

/**
 * Р§РёСЃР»РѕРІРѕРµ РїРѕР»Рµ СЃ С‚РµРєСЃС‚РѕРІС‹Рј С‡РµСЂРЅРѕРІРёРєРѕРј.
 *
 * Р•СЃР»Рё РґРµСЂР¶Р°С‚СЊ РІ СЃРѕСЃС‚РѕСЏРЅРёРё СЃР°РјРѕ С‡РёСЃР»Рѕ (`value={newPrice}` Рё `Number(e.target.value)`),
 * РїРѕР»Рµ РЅРµРІРѕР·РјРѕР¶РЅРѕ РѕС‡РёСЃС‚РёС‚СЊ: РїСЂРё СЃС‚РёСЂР°РЅРёРё Р·РЅР°С‡РµРЅРёРµ РјРіРЅРѕРІРµРЅРЅРѕ СЃС‚Р°РЅРѕРІРёС‚СЃСЏ 0 Рё С†РёС„СЂС‹
 * РІРѕР·РІСЂР°С‰Р°СЋС‚СЃСЏ РЅР° РјРµСЃС‚Рѕ, РїРѕСЌС‚РѕРјСѓ РІСЂСѓС‡РЅСѓСЋ РІРїРёСЃР°С‚СЊ С†РµРЅСѓ РёР»Рё РіСЂР°РјРјРѕРІРєСѓ РЅРµР»СЊР·СЏ вЂ”
 * РѕСЃРѕР±РµРЅРЅРѕ СЃ С‚РµР»РµС„РѕРЅР°. Р—РґРµСЃСЊ РїРѕР»Рµ РїРѕРјРЅРёС‚ С‚РµРєСЃС‚, РїРѕРєР° РІ РЅРµРіРѕ РїРµС‡Р°С‚Р°СЋС‚, Р° РЅР°СЂСѓР¶Сѓ
 * РѕС‚РґР°С‘С‚ С‡РёСЃР»Рѕ (`emptyValue`, РµСЃР»Рё СЃС‚СЂРѕРєСѓ РѕС‡РёСЃС‚РёР»Рё).
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
        // РџРѕР»Рµ РІРµРґС‘С‚ СЃРµР±СЏ РєР°Рє С‡РёСЃР»РѕРІРѕРµ (С‚РѕР»СЊРєРѕ С†РёС„СЂС‹ Рё СЂР°Р·РґРµР»РёС‚РµР»СЊ), РЅРѕ СЃ
        // `inputMode="decimal"` РЅР° С‚РµР»РµС„РѕРЅРµ РґРѕСЃС‚СѓРїРЅР° Р·Р°РїСЏС‚Р°СЏ РґР»СЏ РґСЂРѕР±РµР№.
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
  const submit = () => { if (pin.length !== 4) { setMessage('Р’РІРµРґРёС‚Рµ С‡РµС‚С‹СЂРµ С†РёС„СЂС‹'); return; } onLogin(pin); };
  useEffect(() => { if (error) setMessage('PIN РЅРµ РїРѕРґРѕС€С‘Р». РџСЂРѕРІРµСЂСЊС‚Рµ РєРѕРґ Рё РїРѕРїСЂРѕР±СѓР№С‚Рµ СЃРЅРѕРІР°.'); }, [error]);
  return <main className="login-wrap">
    <section className="login-art">
      <div className="brand"><div className="brand-mark">Рњ</div> РњРђР РђР”Р <span style={{ color: '#777970', font: '11px Manrope', letterSpacing: '.2em' }}>POS</span></div>
      <div className="login-copy"><div className="eyebrow">Р Р°Р±РѕС‡РёР№ С‚РµСЂРјРёРЅР°Р» В· СЃРјРµРЅР° РЅР°С‡РёРЅР°РµС‚СЃСЏ Р·РґРµСЃСЊ</div><h1>РџРѕСЂСЏРґРѕРє<br />РІ РєР°Р¶РґРѕР№<br /><span style={{ color: '#d4aa4c' }}>СЃРјРµРЅРµ.</span></h1><p>РџСЂРѕРґР°Р¶Рё, РѕСЃС‚Р°С‚РєРё Рё СЂР°СЃС‡С‘С‚С‹ РєРѕРјР°РЅРґС‹ вЂ” РІ РѕРґРЅРѕРј СЃРїРѕРєРѕР№РЅРѕРј СЂРёС‚РјРµ.</p></div>
      <div className="login-foot">РўР•Р РњРРќРђР› РњРђР РђР”Р В· Р”Р›РЇ РљРћРњРђРќР”Р«</div>
    </section>
    <section className="login-panel"><div className="login-box">
      <div className="eyebrow">Р”РѕР±СЂРѕ РїРѕР¶Р°Р»РѕРІР°С‚СЊ</div><h2 className="display" style={{ fontSize: 32, margin: 0 }}>Р’С…РѕРґ РїРѕ PIN</h2>
      <p className="subhead">Р’РІРµРґРёС‚Рµ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹Р№ С‡РµС‚С‹СЂС‘С…Р·РЅР°С‡РЅС‹Р№ РєРѕРґ</p>
      <div className="pin-display" aria-label={`Р’РІРµРґРµРЅРѕ ${pin.length} С†РёС„СЂ`}>{[0, 1, 2, 3].map(i => <span key={i} className={`pin-dot ${pin.length > i ? 'filled' : ''}`} />)}</div>
      <div className="keypad">{['1','2','3','4','5','6','7','8','9','вЊ«','0','РЎР±СЂРѕСЃРёС‚СЊ'].map(k => <button key={k} className="key" onClick={() => k === 'вЊ«' ? setPin(pin.slice(0, -1)) : k === 'РЎР±СЂРѕСЃРёС‚СЊ' ? setPin('') : push(k)} data-testid={`key-${k}`}>{k}</button>)}<button className="key submit" onClick={submit} disabled={pending} data-testid="button-login">{pending ? 'РџСЂРѕРІРµСЂСЏРµРј РєРѕРґвЂ¦' : 'РџСЂРѕРґРѕР»Р¶РёС‚СЊ'}</button></div>
      {message && <p style={{ color: '#df897d', textAlign: 'center', fontSize: 12 }}>{message}</p>}
      <div className="divider" /><div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', color: '#777b81', fontSize: 11 }}><LockKeyhole size={14} /> Р”РѕСЃС‚СѓРї Р·Р°С‰РёС‰С‘РЅ PIN-РєРѕРґРѕРј</div>
    </div></section>
  </main>;
}

function Shell({ children, role, logout, saving = false, saveFailed = false, saveError = '' }: { children: ReactNode; role: string; logout: () => void; saving?: boolean; saveFailed?: boolean; saveError?: string }) {
  const [path] = useLocation();
  const nav = [{ href: '/shift', label: 'РЎРјРµРЅР°', icon: Coffee }, { href: '/inventory', label: 'РЎРєР»Р°Рґ', icon: Boxes }, { href: '/reports', label: 'РћС‚С‡С‘С‚С‹', icon: BarChart3 }, { href: '/settings', label: 'РќР°СЃС‚СЂРѕР№РєРё', icon: Settings2 }];
  const activeTab = nav.some((item) => item.href === path) ? path : '/shift';

  return <div className="app-shell">
    <header className="topbar"><Link href="/shift" className="brand"><span className="brand-mark">Рњ</span> РњРђР РђР”Р <span style={{ color: '#777970', font: '10px Manrope', letterSpacing: '.2em' }}>POS</span></Link>
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
      <div className="top-right">{saving && <span className="saving">РЎРѕС…СЂР°РЅСЏРµРјвЂ¦</span>}{saveFailed && <span role="alert" className="saving" style={{color:'#df897d'}} title={saveError || undefined}>РќРµ СЃРѕС…СЂР°РЅРµРЅРѕ В· РїСЂРёС‡РёРЅР° РІ РќР°СЃС‚СЂРѕР№РєР°С…</span>}<span className="role-pill">{role === 'admin' ? 'РђРґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ' : 'РЎРѕС‚СЂСѓРґРЅРёРє'}</span><div className="user-chip"><span className="avatar">{role === 'admin' ? 'A' : 'РЎ'}</span><span>РўРµСЂРјРёРЅР°Р»</span></div><button title="Р’С‹Р№С‚Рё" className="btn btn-quiet btn-sm" onClick={logout} data-testid="button-logout"><DoorOpen size={16} /></button></div>
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
  // РђРєС‚СѓР°Р»СЊРЅС‹Рµ РєРѕСЌС„С„РёС†РёРµРЅС‚С‹ СЃРїРёСЃР°РЅРёСЏ: Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ РјРµРЅСЏРµС‚ РёС… РІ РЅР°СЃС‚СЂРѕР№РєР°С…,
  // СЃРјРµРЅР° СЃС‡РёС‚Р°РµС‚ РїРѕ СЃРѕС…СЂР°РЅС‘РЅРЅС‹Рј РІ Р‘Р” Р·РЅР°С‡РµРЅРёСЏРј.
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
  // Р§РµСЂРЅРѕРІРёРє РѕС‚РґРµР»СЊРЅРѕР№ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё РђРјРёРґСѓ: РѕРЅ РЅРµ РІС…РѕРґРёС‚ РІ РѕР±СЉРµРєС‚ СЃРјРµРЅС‹ Рё РЅРµ
  // СѓС‡Р°СЃС‚РІСѓРµС‚ РІ saveShift вЂ” Р·Р°РїРёСЃСЊ РёРґС‘С‚ С‚РѕР»СЊРєРѕ С‡РµСЂРµР· saveAmidExtra, РїРѕСЌС‚РѕРјСѓ
  // РІРІРѕРґ СЃСѓРјРјС‹ РЅРµ РѕС‚РєСЂС‹РІР°РµС‚, РЅРµ Р·Р°РєСЂС‹РІР°РµС‚ Рё РЅРµ СЂРµРіРёСЃС‚СЂРёСЂСѓРµС‚ СЃРјРµРЅСѓ.
  const [amidExtra, setAmidExtra] = useState(0);
  const [amidMsg, setAmidMsg] = useState("");
  // Р§РµСЂРЅРѕРІРёРє РїР»Р°С€РєРё В«РџСЂР°РІРёР»Р° СЂР°СЃС‡С‘С‚Р°В»: null вЂ” РїСЂРѕСЃРјРѕС‚СЂ, РјР°СЃСЃРёРІ вЂ” СЂРµР¶РёРј РїСЂР°РІРєРё.
  const [rulesDraft, setRulesDraft] = useState<CalculationRule[] | null>(null);
  // РљРѕРЅСЃС‚СЂСѓРєС‚РѕСЂ РїСЂР°РІРёР» СЃРїРёСЃР°РЅРёСЏ: null вЂ” РїСЂРѕСЃРјРѕС‚СЂ, РёРЅР°С‡Рµ С‡РµСЂРЅРѕРІРёРє РїСЂР°РІРёР»Р°.
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
      window.alert("РЈРєР°Р¶РёС‚Рµ РїСЂРёС‡РёРЅСѓ РґР»СЏ РєР°Р¶РґРѕР№ СЃРєРёРґРєРё.");
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
    // РђРІС‚РѕСЃРїРёСЃР°РЅРёРµ РїРѕ РІСЃРµРј Р°РєС‚РёРІРЅС‹Рј РїСЂР°РІРёР»Р°Рј: Р±Р°Р·РѕРІС‹Рµ РєРѕСЌС„С„РёС†РёРµРЅС‚С‹ РїР»СЋСЃ
    // РїСЂР°РІРёР»Р° РєРѕРЅСЃС‚СЂСѓРєС‚РѕСЂР°. Р Р°СЃРєР»Р°РґРєР° вЂ” РїРѕ РїРѕР·РёС†РёСЏРј СЃРєР»Р°РґР°, РєР°Рє РЅР° СЃРµСЂРІРµСЂРµ.
    const allocation = allocateShiftUsage(
      shift,
      state.inventory,
      usage,
      state.usageRules,
    );
    if (allocation.short) {
      window.alert(
        "РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ СЃС‹СЂСЊСЏ РЅР° СЃРєР»Р°РґРµ РґР»СЏ СЃРїРёСЃР°РЅРёСЏ РїРѕ РїСЂР°РІРёР»Р°Рј. РЎРЅР°С‡Р°Р»Р° РІРЅРµСЃРёС‚Рµ РїРѕСЃС‚Р°РІРєСѓ РёР»Рё СЃРєРѕСЂСЂРµРєС‚РёСЂСѓР№С‚Рµ РѕСЃС‚Р°С‚РѕРє.",
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
        setSavedMsg("РЎРјРµРЅР° Р·Р°РїРёСЃР°РЅР° РІ Р¶СѓСЂРЅР°Р»");
        window.setTimeout(() => setSavedMsg(""), 3500);
      },
    );
  };
  // РР·РѕР»РёСЂРѕРІР°РЅРЅР°СЏ РѕРїРµСЂР°С†РёСЏ: СЃРѕС…СЂР°РЅСЏРµС‚ С‚РѕР»СЊРєРѕ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєСѓ РђРјРёРґСѓ, РЅРµ С‚СЂРѕРіР°СЏ
  // С‡РµСЂРЅРѕРІРёРє СЃРјРµРЅС‹, СЃРєР»Р°Рґ Рё Р¶СѓСЂРЅР°Р» СЃРјРµРЅ.
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
        setAmidMsg(`Р”РѕРїР»Р°С‚Р° ${rub(amount)} Р·Р°РїРёСЃР°РЅР° РѕС‚РґРµР»СЊРЅРѕ РѕС‚ СЃРјРµРЅС‹`);
        window.setTimeout(() => setAmidMsg(""), 3500);
      },
    );
  };
  // РџР»Р°С€РєР° В«РџСЂР°РІРёР»Р° СЂР°СЃС‡С‘С‚Р°В»: РґРёРЅР°РјРёС‡РµСЃРєРёР№ СЃРїРёСЃРѕРє РїРѕРґ РїРѕР»РЅС‹Рј РєРѕРЅС‚СЂРѕР»РµРј РІР»Р°РґРµР»СЊС†Р°.
  // Р Р°Р±РѕС‚РЅРёРєР°Рј РєР°СЂР°РЅРґР°С€ РЅРµ РїРѕРєР°Р·С‹РІР°РµРј вЂ” СЃРµСЂРІРµСЂ РІСЃС‘ СЂР°РІРЅРѕ РѕС‚РєР»РѕРЅРёС‚ РїСЂР°РІРєСѓ.
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
  // РљРѕРЅСЃС‚СЂСѓРєС‚РѕСЂ РїСЂР°РІРёР» СЃРїРёСЃР°РЅРёСЏ СЃС‹СЂСЊСЏ (state.usageRules): РєР°Р¶РґРѕРµ РїСЂР°РІРёР»Рѕ вЂ”
  // РЅР°Р·РІР°РЅРёРµ, РјР°С‚РµСЂРёР°Р» СЃРѕ СЃРєР»Р°РґР°, СЂР°СЃС…РѕРґ Рё С‚РёРї РѕРїРµСЂР°С†РёРё. РЎРѕС…СЂР°РЅСЏРµС‚СЃСЏ РІ Р‘Р” Рё
  // РїСЂРёРјРµРЅСЏРµС‚СЃСЏ Рє РЅРѕРІС‹Рј СЃРјРµРЅР°Рј СЃСЂР°Р·Сѓ; РїСЂР°РІРёР»Р° СЃРєР»Р°РґР° СЂР°Р±РѕС‚РЅРёРє РЅРµ РјРµРЅСЏРµС‚.
  const usageRulesList = state.usageRules ?? [];
  const startNewUsageRule = () => {
    if (!state.inventory.length) {
      window.alert("РЎРЅР°С‡Р°Р»Р° РґРѕР±Р°РІСЊС‚Рµ РїРѕР·РёС†РёСЋ РЅР° СЃРєР»Р°Рґ вЂ” РїСЂР°РІРёР»Сѓ РЅСѓР¶РµРЅ РјР°С‚РµСЂРёР°Р».");
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
    if (!window.confirm("РЈРґР°Р»РёС‚СЊ РїСЂР°РІРёР»Рѕ СЃРїРёСЃР°РЅРёСЏ?")) return;
    saveState(
      { ...state, usageRules: usageRulesList.filter((entry) => entry.id !== id) },
      () => setUsageRuleDraft(null),
    );
  };
  const visibleRevenue = canRevenue;
  // Р–РёРІР°СЏ СЃРІРѕРґРєР° СЃРїРёСЃР°РЅРёСЏ: СЃРєР°РЅРёСЂСѓРµС‚ Р±Р°Р·РѕРІС‹Рµ РєРѕСЌС„С„РёС†РёРµРЅС‚С‹ Рё РїСЂР°РІРёР»Р°
  // РєРѕРЅСЃС‚СЂСѓРєС‚РѕСЂР° вЂ” СЂРѕРІРЅРѕ С‚Рѕ, С‡С‚Рѕ Р±СѓРґРµС‚ РІС‹С‡С‚РµРЅРѕ СЃРѕ СЃРєР»Р°РґР° РїСЂРё Р·Р°РєСЂС‹С‚РёРё СЃРјРµРЅС‹.
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
          <div className="eyebrow">РћРїРµСЂР°С†РёРѕРЅРЅС‹Р№ Р¶СѓСЂРЅР°Р» / СЃРµРіРѕРґРЅСЏ</div>
          <h1>Р’РІРѕРґ СЃРјРµРЅС‹</h1>
          <div className="subhead">
            Р—Р°С„РёРєСЃРёСЂСѓР№С‚Рµ РєР°Р¶РґСѓСЋ С‡Р°С€Сѓ Рё СЂР°СЃС…РѕРґС‹ РєРѕРјР°РЅРґС‹ РґРѕ Р·Р°РєСЂС‹С‚РёСЏ.
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
          РЎРјРµРЅР° РѕС‚РєСЂС‹С‚Р°
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
              <span>01 / РљС‚Рѕ РЅР° СЃРјРµРЅРµ</span>
              <Users size={16} color="#b69a59" />
            </div>
            <div
              className="grid"
              style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}
            >
              <div>
                <label className="label">РЎРѕС‚СЂСѓРґРЅРёРєРё РЅР° СЃРјРµРЅРµ</label>
                <div className="employee-picker" role="group" aria-label="РЎРѕС‚СЂСѓРґРЅРёРєРё РЅР° СЃРјРµРЅРµ" data-testid="select-master">
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
                <label className="label">Р”Р°С‚Р° СЃРјРµРЅС‹</label>
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
              <span>Р”РѕР±Р°РІРёС‚СЊ РєР°Р»СЊСЏРЅ</span>
              <span className="tag">{lines.length} РІ СЃРјРµРЅРµ</span>
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
                    <span className="grams">{item.tobaccoGrams} Рі</span>
                    <div className="price">{rub(item.price)}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                Р”Р»СЏ РІР°С€РµР№ СѓС‡С‘С‚РЅРѕР№ Р·Р°РїРёСЃРё РїРѕРєР° РЅРµ РѕС‚РєСЂС‹С‚С‹ РїРѕР·РёС†РёРё РјРµРЅСЋ.
              </div>
            )}
          </div>
          <div className="card">
            <div className="section-title">
              <span>02 / РџРѕР·РёС†РёРё СЃРјРµРЅС‹</span>
              <span className="tag gold">{lines.length} РєР°Р»СЊСЏРЅРѕРІ</span>
            </div>
            {!lines.length ? (
              <div className="empty">
                Р’С‹Р±РµСЂРёС‚Рµ РїРѕР·РёС†РёСЋ РјРµРЅСЋ вЂ” РѕРЅР° РїРѕСЏРІРёС‚СЃСЏ Р·РґРµСЃСЊ.
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
                        {line.tobaccoGrams} Рі С‚Р°Р±Р°РєР°
                      </div>
                    </div>
                    {state.permissions.useDiscounts || isAdmin ? (
                      <div
                        className="discount-options"
                        role="group"
                        aria-label="РЎРєРёРґРєР°"
                        data-testid={`select-discount-${line.id}`}
                      >
                        {DISCOUNTS.map((discount) => (
                          <button
                            key={discount}
                            type="button"
                            className={`discount-option ${line.discount === discount ? "active" : ""}`}
                            aria-label={discount === 0 ? "Р‘РµР· СЃРєРёРґРєРё" : `РЎРєРёРґРєР° ${discount}%`}
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
                      <span className="tag">Р‘РµР· СЃРєРёРґРєРё</span>
                    )}
                    <span
                      className="mono"
                      style={{ textAlign: "right", fontSize: 12 }}
                    >
                      {rub(saleAmount(line.unitPrice, line.discount))}
                    </span>
                    <button
                      className="btn btn-quiet btn-sm"
                      aria-label="РЈРґР°Р»РёС‚СЊ РєР°Р»СЊСЏРЅ"
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
                        <label className="label">РџСЂРёС‡РёРЅР° СЃРєРёРґРєРё</label>
                        <input
                          className="input"
                          placeholder="РќР°РїСЂРёРјРµСЂ: РїРѕСЃС‚РѕСЏРЅРЅС‹Р№ РіРѕСЃС‚СЊ"
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
                <label className="label">РџРѕРјРѕС‰РЅРёРєР°Рј, в‚Ѕ</label>
                <NumberField
                  className="input"
                  min="0"
                  value={helpersPay}
                  onCommit={(next) => setHelpersPay(Math.max(0, next))}
                  data-testid="input-helpers-pay"
                />
              </div>
              <div>
                <label className="label">РџРµСЂРµР·Р°Р±РёРІРєРё</label>
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
                  <label className="label">Р—Р°РєСѓРїРєР° Р·Р° СЃРјРµРЅСѓ, в‚Ѕ</label>
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
                  <label className="label">РћРєР»Р°Рґ СЌС‚РѕР№ СЃРјРµРЅС‹, в‚Ѕ</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    placeholder="РџРѕ СѓРјРѕР»С‡Р°РЅРёСЋ"
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
              <label className="label">РљРѕРјРјРµРЅС‚Р°СЂРёР№ Рє СЃРјРµРЅРµ</label>
              <textarea
                className="textarea"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="РћСЃРѕР±С‹Рµ РѕР±СЃС‚РѕСЏС‚РµР»СЊСЃС‚РІР°, СЃРїРёСЃР°РЅРёСЏвЂ¦"
                data-testid="input-shift-comment"
              />
            </div>
          </div>
          <div className="card">
            <div className="section-title">
              <span>03 / РћС‚РґРµР»СЊРЅР°СЏ РѕРїРµСЂР°С†РёСЏ</span>
              <ArrowDownToLine size={16} color="#b69a59" />
            </div>
            <p style={{ color: "#858990", fontSize: 11, lineHeight: 1.6, margin: "0 0 13px" }}>
              Р”РѕРїР»Р°С‚Р° {SHIFT_BONUS_OWNER_NAME}Сѓ Р·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕР№ Р·Р°РїРёСЃСЊСЋ: РѕРЅР° РЅРµ РѕС‚РєСЂС‹РІР°РµС‚,
              РЅРµ Р·Р°РєСЂС‹РІР°РµС‚ Рё РЅРµ РјРµРЅСЏРµС‚ СЃРјРµРЅСѓ, РЅРѕ СѓС‡РёС‚С‹РІР°РµС‚СЃСЏ РІ Р¤РћРў Рё РІ СЂР°СЃС‡С‘С‚Рµ РїРѕ РјР°СЃС‚РµСЂР°Рј.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px" }}>
                <label className="label">{`${SHIFT_BONUS_OWNER_NAME}Сѓ РґРѕРїРѕР»РЅРёС‚РµР»СЊРЅРѕ, в‚Ѕ`}</label>
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
                <Check size={16} /> Р—Р°РїРёСЃР°С‚СЊ РѕС‚РґРµР»СЊРЅРѕ
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
              <span>РЎРІРѕРґРєР° СЃРјРµРЅС‹</span>
              <Clock3 size={16} color="#d4aa4c" />
            </div>
            {visibleRevenue ? (
              <>
                <div className="kpi-label">Р’Р«Р РЈР§РљРђ РџРћ РџРћР—РР¦РРЇРњ</div>
                <div className="kpi-value">{rub(total)}</div>
                <div className="divider" />
              </>
            ) : (
              <div className="notice" style={{ marginBottom: 17 }}>
                Р’С‹СЂСѓС‡РєР° СЃРєСЂС‹С‚Р° РЅР°СЃС‚СЂРѕР№РєР°РјРё РґРѕСЃС‚СѓРїР°.
              </div>
            )}
            <div style={{ display: "grid", gap: 12 }}>
              <SummaryRow label="РљР°Р»СЊСЏРЅС‹" value={`${lines.length} С€С‚.`} />
              <SummaryRow
                label="РЈРіРѕР»СЊ СЃРїРёСЃР°РЅ"
                value={`${kgUsed.toFixed(3)} РєРі`}
              />
              <SummaryRow label="РўР°Р±Р°Рє СѓС‡С‚С‘РЅ" value={`${tobacco} Рі`} />
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
                    label="Р—Р°СЂРїР»Р°С‚Р° СЃРѕС‚СЂСѓРґРЅРёРєРѕРІ"
                    value={rub(payroll)}
                    highlight
                  />
                  {selectedEmployees.length > 1 &&
                    selectedEmployees.map((name) => (
                      <SummaryRow
                        key={name}
                        label={`в†і ${name}: РѕРєР»Р°Рґ + РґРѕР»СЏ РїСЂРѕС†РµРЅС‚Р°`}
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
                  <SummaryRow label="Р—Р°РєСѓРїРєР°" value={rub(purchaseAmount)} />
                  <SummaryRow label="РџРѕРјРѕС‰РЅРёРєРё" value={rub(helpersPay)} />
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
              <Check size={16} /> {saving ? "РЎРѕС…СЂР°РЅСЏРµРјвЂ¦" : "Р—Р°РїРёСЃР°С‚СЊ СЃРјРµРЅСѓ"}
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
              Р—Р°РїРёСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЃСЏ РІ РѕР±С‰РµР№ РёСЃС‚РѕСЂРёРё Рё РѕС‚С‡С‘С‚Р°С….
            </p>
          </div>
          <div className="card">
            <div className="section-title">
              <span>РџСЂР°РІРёР»Р° СЂР°СЃС‡С‘С‚Р°</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {isAdmin && rulesDraft === null && (
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={startRulesEdit}
                    aria-label="Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ РїСЂР°РІРёР»Р°"
                    title="Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ РїСЂР°РІРёР»Р°"
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
                      <Check size={14} /> РЎРѕС…СЂР°РЅРёС‚СЊ
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={saving}
                      onClick={cancelRulesEdit}
                      data-testid="button-cancel-rules"
                    >
                      РћС‚РјРµРЅР°
                    </button>
                  </>
                )}
                <CircleHelp size={16} color="#858990" />
              </span>
            </div>
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
                <div className="empty">РџСЂР°РІРёР» РїРѕРєР° РЅРµС‚.</div>
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
                        placeholder="РќР°Р·РІР°РЅРёРµ (РЅР°РїСЂРёРјРµСЂ, РЈРіРѕР»СЊ)"
                        aria-label="РќР°Р·РІР°РЅРёРµ РїСЂР°РІРёР»Р°"
                        data-testid={`input-rule-name-${rule.id}`}
                      />
                      <input
                        className="input"
                        style={EDIT_CELL_INPUT_STYLE}
                        value={rule.rule}
                        onChange={(e) =>
                          changeRuleDraft(rule.id, { rule: e.target.value })
                        }
                        placeholder="РћРїРёСЃР°РЅРёРµ РїСЂР°РІРёР»Р° (С‚РµРєСЃС‚ РёР»Рё РЅРѕСЂРјС‹ СЂР°СЃС…РѕРґР°)"
                        aria-label="РћРїРёСЃР°РЅРёРµ РїСЂР°РІРёР»Р°"
                        data-testid={`input-rule-text-${rule.id}`}
                      />
                    </div>
                    <button
                      className="btn btn-quiet btn-sm btn-danger"
                      onClick={() => removeRuleDraft(rule.id)}
                      aria-label="РЈРґР°Р»РёС‚СЊ РїСЂР°РІРёР»Рѕ"
                      title="РЈРґР°Р»РёС‚СЊ РїСЂР°РІРёР»Рѕ"
                      data-testid={`button-remove-rule-${rule.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
</div>
                ))}
                <button
                  className="btn btn-sm"
                  onClick={addRuleDraft}
                  data-testid="button-add-rule"
                >
                  <Plus size={14} /> Р”РѕР±Р°РІРёС‚СЊ РїСЂР°РІРёР»Рѕ
                </button>
              </div>
            )}
            <div className="divider" />
            <div className="section-title">
              <span>РџСЂР°РІРёР»Р° СЃРїРёСЃР°РЅРёСЏ СЃС‹СЂСЊСЏ</span>
              {isAdmin && !usageRuleDraft && (
                <button
                  className="btn btn-quiet btn-sm"
                  onClick={startNewUsageRule}
                  aria-label="РќРѕРІРѕРµ РїСЂР°РІРёР»Рѕ СЃРїРёСЃР°РЅРёСЏ"
                  title="РќРѕРІРѕРµ РїСЂР°РІРёР»Рѕ СЃРїРёСЃР°РЅРёСЏ"
                  data-testid="button-add-usage-rule"
                >
                  <Plus size={15} />
                </button>
              )}
            </div>
            <div className="notice" style={{ marginBottom: 12 }}>
              Р‘Р°Р·РѕРІС‹Рµ РєРѕСЌС„С„РёС†РёРµРЅС‚С‹ вЂ” СѓРіРѕР»СЊ{" "}
              {Math.round(usage.coalKgPerHookah * 1000)} Рі РЅР° РєР°Р»СЊСЏРЅ Рё{" "}
              {Math.round(usage.coalKgPerRebuild * 1000)} Рі РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ, С‚Р°Р±Р°Рє{" "}
              {usage.tobaccoGramsPerRebuild} Рі РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ вЂ” РїСЂР°РІСЏС‚СЃСЏ РІ
              В«РќР°СЃС‚СЂРѕР№РєРё в†’ Р Р°СЃС…РѕРґ СЃС‹СЂСЊСЏВ». РЎРѕР±СЃС‚РІРµРЅРЅС‹Рµ РїСЂР°РІРёР»Р° СЃРїРёСЃС‹РІР°СЋС‚СЃСЏ РІРјРµСЃС‚Рµ
              СЃ Р±Р°Р·РѕР№ РїСЂРё Р·Р°РєСЂС‹С‚РёРё СЃРјРµРЅС‹.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
                    gap: 9,
                    alignItems: "end",
                  }}
                >
                  <div style={{ gridColumn: "1 / -1" }}>
                    <label className="label">РќР°Р·РІР°РЅРёРµ</label>
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
                      placeholder="Р Р°СЃС…РѕРґ РЅР° С„СЂСѓРєС‚РѕРІСѓСЋ С‡Р°С€Сѓ"
                      aria-label="РќР°Р·РІР°РЅРёРµ РїСЂР°РІРёР»Р° СЃРїРёСЃР°РЅРёСЏ"
                      data-testid="input-usage-rule-name"
                    />
                  </div>
                  <div>
                    <label className="label">РњР°С‚РµСЂРёР°Р» (СЃРєР»Р°Рґ)</label>
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
                      aria-label="РњР°С‚РµСЂРёР°Р» РїСЂР°РІРёР»Р°"
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
                      Р Р°СЃС…РѕРґ,{" "}
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
                      aria-label="Р Р°СЃС…РѕРґ СЃС‹СЂСЊСЏ Р·Р° РѕРїРµСЂР°С†РёСЋ"
                      data-testid="input-usage-rule-amount"
                    />
                  </div>
                  <div>
                    <label className="label">РћРїРµСЂР°С†РёСЏ</label>
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
                      aria-label="РўРёРї РѕРїРµСЂР°С†РёРё"
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
                      <label className="label">РџРѕР·РёС†РёСЏ РјРµРЅСЋ</label>
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
                        aria-label="РџРѕР·РёС†РёСЏ РјРµРЅСЋ РїСЂР°РІРёР»Р°"
                        data-testid="select-usage-rule-menu"
                      >
                        <option value="">Р›СЋР±Р°СЏ РїРѕР·РёС†РёСЏ</option>
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
                    РђРєС‚РёРІРЅРѕ
                  </label>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
                    <button
                      className="btn btn-primary"
                      style={{ minHeight: 42 }}
                      onClick={saveUsageRuleDraft}
                      disabled={saving}
                      data-testid="button-save-usage-rule"
                    >
                      РЎРѕС…СЂР°РЅРёС‚СЊ
                    </button>
                    <button
                      className="btn btn-quiet"
                      style={{ minHeight: 42 }}
                      onClick={cancelUsageRuleDraft}
                      data-testid="button-cancel-usage-rule"
                    >
                      РћС‚РјРµРЅР°
                    </button>
                  </div>
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
  // Р”РѕРїР»Р°С‚Р° РІР»Р°РґРµР»СЊС†Сѓ РІ СЃРјРµРЅСѓ Р±РѕР»СЊС€Рµ РЅРµ РїРёС€РµС‚СЃСЏ: РѕС‚РґРµР»СЊРЅС‹Рµ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё
  // СѓС‡РёС‚С‹РІР°СЋС‚СЃСЏ С‡РµСЂРµР· state.amidAdjustments (СЃРј. sumAmidAdjustments).
  return payroll;
}

function InventoryPage({ state, saveState, isAdmin, saving }: Shared) {
  const [tab, setTab] = useState<"stock" | "deliveries" | "tare" | "usage">("stock");
  // РџРµСЂРёРѕРґ РґР»СЏ РєРѕР»РѕРЅРєРё В«РЎРїРёСЃР°РЅРѕ Р·Р° РїРµСЂРёРѕРґВ» Рё РІРєР»Р°РґРєРё В«РЎРїРёСЃР°РЅРёСЏВ».
  const [usagePeriod, setUsagePeriod] = useState<"day" | "week" | "month">("day");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("tobacco");
  const [brand, setBrand] = useState("");
  const [packageGrams, setPackageGrams] = useState(100);
  const [stock, setStock] = useState(0);
  const [unit, setUnit] = useState("Рі");
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
  // РРЅР»Р°Р№РЅ-СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёРµ СЃС‚СЂРѕРєРё РѕСЃС‚Р°С‚РєРѕРІ: Р°РєС‚РёРІРЅР° С‚РѕР»СЊРєРѕ РѕРґРЅР° СЃС‚СЂРѕРєР° Р·Р° СЂР°Р·.
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
  // РљРѕСЌС„С„РёС†РёРµРЅС‚С‹ СЃРїРёСЃР°РЅРёСЏ Р±РµСЂСѓС‚СЃСЏ РёР· РЅР°СЃС‚СЂРѕРµРє (state.usageSettings) вЂ” С‚Рµ Р¶Рµ,
  // РїРѕ РєРѕС‚РѕСЂС‹Рј СЃРµСЂРІРµСЂ РІРµРґС‘С‚ Р¶СѓСЂРЅР°Р» СЃРїРёСЃР°РЅРёР№ usageLog.
  const usage = resolveUsageSettings(state.usageSettings);
  const coalCurrent = state.inventory
    .filter((item) => categoryKind(item.category) === "coal")
    .reduce((sum, item) => sum + item.stock, 0);
  const coalUsed = state.shifts.reduce(
    (sum, shift) =>
      sum + calcCoalUsageKg(shift.lines.length, shift.rebuilds ?? 0, usage),
    0,
  );
  // РћСЃС‚Р°С‚РѕРє С‚Р°Р±Р°РєР°: РІ РіСЂР°РјРјР°С… РїРѕ РІСЃРµРј РїРѕР·РёС†РёСЏРј Рё РІ СѓРїР°РєРѕРІРєР°С… (РїРѕ С„Р°СЃРѕРІРєРµ).
  const tobaccoCurrent = state.inventory
    .filter((item) => categoryKind(item.category) === "tobacco")
    .reduce((sum, item) => sum + item.stock, 0);
  const tobaccoPackages = state.inventory
    .filter(
      (item) => categoryKind(item.category) === "tobacco" && item.packageGrams > 0,
    )
    .reduce((sum, item) => sum + item.stock / item.packageGrams, 0);
  // Р–СѓСЂРЅР°Р» СЃРїРёСЃР°РЅРёР№ Р·Р° РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ: Р·Р°РїРёСЃРё СЃРѕР·РґР°С‘С‚ СЃРµСЂРІРµСЂ РїРѕ Р·Р°РєСЂС‹С‚С‹Рј
  // СЃРјРµРЅР°Рј Рё С…СЂР°РЅРёС‚ С„РѕСЂРјСѓР»Сѓ СЂР°СЃС‡С‘С‚Р° РЅР° РјРѕРјРµРЅС‚ СЃРїРёСЃР°РЅРёСЏ.
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
    usagePeriod === "day" ? "РґРµРЅСЊ" : usagePeriod === "week" ? "РЅРµРґРµР»СЏ" : "РјРµСЃСЏС†";
  /** РЎРєРѕР»СЊРєРѕ СЃС‹СЂСЊСЏ СЃРїРёСЃР°РЅРѕ СЃ СЌС‚РѕР№ РїРѕР·РёС†РёРё Р·Р° РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ. */
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
      return `${String(Math.round(coalKg * 1000) / 1000)} РєРі`;
    }
    if (categoryKind(item.category) === "tobacco") {
      return `${Math.round(tobaccoGrams)} Рі`;
    }
    return "вЂ”";
  };
  const periodPicker = (
    <div style={{ display: "flex", gap: 4 }}>
      {(
        [
          ["day", "Р”РµРЅСЊ"],
          ["week", "РќРµРґРµР»СЏ"],
          ["month", "РњРµСЃСЏС†"],
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
  // РРЅР»Р°Р№РЅ-СЂРµРґР°РєС‚РёСЂРѕРІР°РЅРёРµ: РєР°СЂР°РЅРґР°С€ РїРµСЂРµРІРѕРґРёС‚ СЃС‚СЂРѕРєСѓ РІ СЂРµР¶РёРј РїСЂР°РІРєРё РІСЃРµС…
  // РїРѕР»РµР№, РіР°Р»РѕС‡РєР° СЃРѕС…СЂР°РЅСЏРµС‚. Р’С…РѕРґ СЂР°Р·СЂРµС€С‘РЅ РїРѕ mayCorrect (РєР°Рє СЂР°РЅСЊС€Рµ), РЅРѕ
  // РєР°СЂС‚РѕС‡РєСѓ (РЅР°Р·РІР°РЅРёРµ/РєР°С‚РµРіРѕСЂРёСЏ/Р±СЂРµРЅРґ/С„Р°СЃРѕРІРєСѓ) РјРµРЅСЏРµС‚ С‚РѕР»СЊРєРѕ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ вЂ”
  // СЃРµСЂРІРµСЂ РґР»СЏ СЂР°Р±РѕС‚РЅРёРєР° РѕС‚РєР»РѕРЅСЏРµС‚ Р»СЋР±С‹Рµ РёР·РјРµРЅРµРЅРёСЏ РєСЂРѕРјРµ РѕСЃС‚Р°С‚РєР°.
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
    if (!trimmedName) return window.alert("РЈРєР°Р¶РёС‚Рµ РЅР°РёРјРµРЅРѕРІР°РЅРёРµ РїРѕР·РёС†РёРё.");
    if (!Number.isFinite(edit.packageGrams) || edit.packageGrams < 0)
      return window.alert("Р¤Р°СЃРѕРІРєР° РґРѕР»Р¶РЅР° Р±С‹С‚СЊ С‡РёСЃР»РѕРј РѕС‚ 0.");
    if (!Number.isFinite(edit.stock) || edit.stock < 0)
      return window.alert("РћСЃС‚Р°С‚РѕРє РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ С‡РёСЃР»РѕРј РѕС‚ 0.");
    // Р•РґРёРЅРёС†Р° РѕР±РЅРѕРІР»СЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ РїСЂРё СЃРјРµРЅРµ РєР°С‚РµРіРѕСЂРёРё вЂ” РїРѕ С‚РѕРјСѓ Р¶Рµ РєР°РЅРѕРЅСѓ, С‡С‚Рѕ Рё
    // РІ С„РѕСЂРјРµ СЃРѕР·РґР°РЅРёСЏ; РёРЅР°С‡Рµ РїРѕР·РёС†РёСЏ СЃРѕС…СЂР°РЅСЏРµС‚ СЃРІРѕСЋ (РЅР°РїСЂРёРјРµСЂ, В«СѓРї.В»).
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
        item.id === weighItem ? { ...item, stock: netGrams, unit: "Рі" } : item,
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
          <div className="eyebrow">РљРѕРЅС‚СЂРѕР»СЊ РѕСЃС‚Р°С‚РєРѕРІ / СЃРєР»Р°Рґ</div>
          <h1>Р—Р°РїР°СЃС‹ Рё РїРѕСЃС‚Р°РІРєРё</h1>
          <div className="subhead">
            РћСЃС‚Р°С‚РєРё СЂР°СЃС…РѕРґРЅРёРєРѕРІ, РїСЂРёС‘РјРєР° РїРѕСЃС‚Р°РІРѕРє Рё С‚Р°СЂР°.
          </div>
        </div>
        <div className="tag gold">
          <Boxes size={13} style={{ marginRight: 6 }} />
          {state.inventory.length} РїРѕР·РёС†РёР№
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
          <div className="kpi-label">РџРћР—РР¦РР™ РќРђ РЎРљР›РђР”Р•</div>
          <div className="kpi-value">{state.inventory.length}</div>
          <div className="kpi-note">СѓС‡РёС‚С‹РІР°СЋС‚СЃСЏ РІ РѕСЃС‚Р°С‚РєР°С…</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">РћРЎРўРђРўРћРљ РЈР“Р›РЇ</div>
          <div className="kpi-value">{coalCurrent.toFixed(2)} РєРі</div>
          <div className="kpi-note">
            РЅР°С‡Р°Р»Рѕ {state.coalOpeningKg.toFixed(2)} В· РїСЂРёС…РѕРґ{" "}
            {coalDeliveries.toFixed(2)} РєРі
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">РћРЎРўРђРўРћРљ РўРђР‘РђРљРђ</div>
          <div className="kpi-value">{Math.round(tobaccoCurrent)} Рі</div>
          <div className="kpi-note">
            в‰€ {tobaccoPackages.toFixed(1)} СѓРїР°РєРѕРІРѕРє РїРѕ С„Р°СЃРѕРІРєРµ
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">РЎРџРРЎРђРќРћ Р—Рђ РџР•Р РРћР”</div>
          <div className="kpi-value">{periodCoalKg.toFixed(2)} РєРі</div>
          <div className="kpi-note">
            СѓРіРѕР»СЊ В· С‚Р°Р±Р°Рє {Math.round(periodTobaccoGrams)} Рі В· {usagePeriodLabel}
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">РЎРџРРЎРђРќРР• Р—Рђ РЎРњР•РќР«</div>
          <div className="kpi-value">{coalUsed.toFixed(2)} РєРі</div>
          <div className="kpi-note">
            {usage.coalKgPerHookah * 1000} Рі РЅР° РєР°Р»СЊСЏРЅ В·{" "}
            {usage.coalKgPerRebuild * 1000} Рі РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ
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
              ["stock", "РћСЃС‚Р°С‚РєРё"],
              ["deliveries", "РџСЂРёС‘РјРєР°"],
              ["tare", "РўР°СЂР°"],
              ["usage", "РЎРїРёСЃР°РЅРёСЏ"],
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
              <span>РўРµРєСѓС‰РёР№ РѕСЃС‚Р°С‚РѕРє</span>
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
                    <Plus size={14} /> РќРѕРІР°СЏ РїРѕР·РёС†РёСЏ
                  </button>
                )}
              </div>
            </div>
            {!state.inventory.length ? (
              <div className="empty">
                РЎРєР»Р°Рґ РїРѕРєР° РїСѓСЃС‚. Р”РѕР±Р°РІСЊС‚Рµ РїРµСЂРІСѓСЋ РїРѕР·РёС†РёСЋ РёР»Рё РІРЅРµСЃРёС‚Рµ РїРѕСЃС‚Р°РІРєСѓ.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>РџРѕР·РёС†РёСЏ</th>
                      <th>РљР°С‚РµРіРѕСЂРёСЏ</th>
                      <th>Р‘СЂРµРЅРґ</th>
                      <th>Р¤Р°СЃРѕРІРєР°</th>
                      <th>РћСЃС‚Р°С‚РѕРє</th>
                      <th title={`РЎРїРёСЃР°РЅРѕ Р·Р° РїРµСЂРёРѕРґ: ${usageRange.from} вЂ” ${usageRange.to}`}>
                        РЎРїРёСЃР°РЅРѕ Р·Р° РїРµСЂРёРѕРґ
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.inventory.map((item) => {
                      // РђРєС‚РёРІРЅР° С‚РѕР»СЊРєРѕ РѕРґРЅР° СЃС‚СЂРѕРєР° Р·Р° СЂР°Р·.
                      const editing = edit?.id === item.id ? edit : null;
                      const detailTitle = isAdmin
                        ? undefined
                        : "РљР°СЂС‚РѕС‡РєСѓ РїРѕР·РёС†РёРё СЂРµРґР°РєС‚РёСЂСѓРµС‚ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ";
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
                                aria-label="РџРѕР·РёС†РёСЏ"
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
                                aria-label="РљР°С‚РµРіРѕСЂРёСЏ"
                                data-testid="select-edit-item-category"
                              >
                                <option value="tobacco">РўР°Р±Р°Рє</option>
                                <option value="coal">РЈРіРѕР»СЊ</option>
                                <option value="consumables">Р Р°СЃС…РѕРґРЅРёРєРё</option>
                                <option value="other">РџСЂРѕС‡РµРµ</option>
                              </select>
                            ) : categoryKind(item.category) === "coal" ? (
                              "РЈРіРѕР»СЊ"
                            ) : categoryKind(item.category) === "tobacco" ? (
                              "РўР°Р±Р°Рє"
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
                                placeholder="РњР°СЂРєР°"
                                title={detailTitle}
                                aria-label="Р‘СЂРµРЅРґ"
                                data-testid="input-edit-item-brand"
                              />
                            ) : (
                              item.brand || "вЂ”"
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
                                aria-label="Р¤Р°СЃРѕРІРєР°, Рі"
                                data-testid="input-edit-item-package-grams"
                              />
                            ) : (
                              `${item.packageGrams} Рі`
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
                                aria-label="РћСЃС‚Р°С‚РѕРє"
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
                            title={`РђРІС‚РѕРјР°С‚РёС‡РµСЃРєРѕРµ СЃРїРёСЃР°РЅРёРµ Р·Р° РїРµСЂРёРѕРґ (${usageRange.from} вЂ” ${usageRange.to})`}
                          >
                            {itemWrittenOff(item)}
                          </td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {mayCorrect && !editing && (
                              <button
                                className="btn btn-quiet btn-sm"
                                onClick={() => startEdit(item)}
                                aria-label="Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ РїРѕР·РёС†РёСЋ"
                                title="Р РµРґР°РєС‚РёСЂРѕРІР°С‚СЊ"
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
                                  aria-label="РЎРѕС…СЂР°РЅРёС‚СЊ"
                                  title="РЎРѕС…СЂР°РЅРёС‚СЊ"
                                  data-testid={`button-save-item-${item.id}`}
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  className="btn btn-quiet btn-sm"
                                  disabled={saving}
                                  onClick={cancelEdit}
                                  aria-label="РћС‚РјРµРЅР°"
                                  title="РћС‚РјРµРЅР°"
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
                                aria-label="РЈРґР°Р»РёС‚СЊ"
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
                  <span>РќРѕРІР°СЏ СЃРєР»Р°РґСЃРєР°СЏ РїРѕР·РёС†РёСЏ</span>
                  <Plus size={15} color="#d4aa4c" />
                </div>
                <div
                  className="grid"
                  style={{ gridTemplateColumns: "repeat(3,1fr)", gap: 11 }}
                >
                  <div>
                    <label className="label">РќР°РёРјРµРЅРѕРІР°РЅРёРµ</label>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="РќР°РїСЂРёРјРµСЂ, С‚Р°Р±Р°Рє"
                      data-testid="input-item-name"
                    />
                  </div>
                  <div>
                    <label className="label">РљР°С‚РµРіРѕСЂРёСЏ</label>
                    <select
                      className="select"
                      value={category}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCategory(value);
                        setUnit(inventoryUnitForCategory(value));
                      }}
                    >
                      <option value="tobacco">РўР°Р±Р°Рє</option>
                      <option value="coal">РЈРіРѕР»СЊ</option>
                      <option value="consumables">Р Р°СЃС…РѕРґРЅРёРєРё</option>
                      <option value="other">РџСЂРѕС‡РµРµ</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Р‘СЂРµРЅРґ</label>
                    <input
                      className="input"
                      value={brand}
                      onChange={(e) => setBrand(e.target.value)}
                      placeholder="РњР°СЂРєР°"
                    />
                  </div>
                  <div>
                    <label className="label">Р¤Р°СЃРѕРІРєР°, Рі</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={packageGrams}
                      onCommit={setPackageGrams}
                      aria-label="Р¤Р°СЃРѕРІРєР°, РіСЂР°РјРј"
                    />
                  </div>
                  <div>
                    <label className="label">РћСЃС‚Р°С‚РѕРє</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={stock}
                      onCommit={setStock}
                      aria-label="РћСЃС‚Р°С‚РѕРє"
                    />
                  </div>
                  <div>
                    <label className="label">Р•РґРёРЅРёС†Р°</label>
                    <select
                      className="select"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                    >
                      <option>Рі</option>
                      <option>РєРі</option>
                      <option>СѓРї.</option>
                      <option>С€С‚.</option>
                      <option>РєРѕСЂ.</option>
                    </select>
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 13 }}
                  onClick={createItem}
                  data-testid="button-create-inventory"
                >
                  <Plus size={14} /> Р”РѕР±Р°РІРёС‚СЊ РЅР° СЃРєР»Р°Рґ
                </button>
              </div>
            )}
          </>
        )}
        {tab === "deliveries" && (
          <>
            <div className="section-title">
              <span>РџСЂРёС…РѕРґ С‚РѕРІР°СЂР°</span>
              <ArrowDownToLine size={16} color="#d4aa4c" />
            </div>
            {!mayAdd && (
              <div className="notice" style={{ marginBottom: 14 }}>
                РџСЂРёС‘РјРєСѓ РјРѕР¶РµС‚ РІРЅРѕСЃРёС‚СЊ С‚РѕР»СЊРєРѕ СЃРѕС‚СЂСѓРґРЅРёРє СЃ СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓСЋС‰РёРј
                РґРѕСЃС‚СѓРїРѕРј.
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
                <label className="label">РџРѕР·РёС†РёСЏ СЃРєР»Р°РґР°</label>
                <select
                  className="select"
                  value={deliveryItem}
                  onChange={(e) => setDeliveryItem(e.target.value)}
                >
                  <option value="">Р’С‹Р±РµСЂРёС‚Рµ РїРѕР·РёС†РёСЋ</option>
                  {state.inventory.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} В· СЃРµР№С‡Р°СЃ {i.stock} {i.unit}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">
                  РљРѕР»РёС‡РµСЃС‚РІРѕ (
                  {state.inventory.find((i) => i.id === deliveryItem)?.unit ??
                    "РµРґ."}
                  )
                </label>
                <NumberField
                  className="input"
                  min="0.001"
                  step="any"
                  value={deliveryQty}
                  onCommit={setDeliveryQty}
                  aria-label="РљРѕР»РёС‡РµСЃС‚РІРѕ РґР»СЏ РїСЂРёС‘РјРєРё"
                />
              </div>
              <button
                className="btn btn-primary"
                disabled={!mayAdd || !deliveryItem}
                onClick={recordDelivery}
                data-testid="button-record-delivery"
              >
                <Check size={15} /> РџСЂРёРЅСЏС‚СЊ
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
                <label className="label">РќР°С‡Р°Р»СЊРЅС‹Р№ РѕСЃС‚Р°С‚РѕРє СѓРіР»СЏ, РєРі</label>
                <NumberField
                  className="input"
                  min="0"
                  step=".1"
                  value={coal}
                  disabled={!mayCorrect}
                  onCommit={setCoal}
                  aria-label="РќР°С‡Р°Р»СЊРЅС‹Р№ РѕСЃС‚Р°С‚РѕРє СѓРіР»СЏ, РєРі"
                />
              </div>
              <button
                className="btn"
                disabled={!mayCorrect}
                onClick={() => saveState({ ...state, coalOpeningKg: coal })}
                data-testid="button-save-coal"
              >
                <Flame size={15} /> РЎРѕС…СЂР°РЅРёС‚СЊ РѕСЃС‚Р°С‚РѕРє
              </button>
            </div>
          </>
        )}
        {tab === "tare" && (
          <>
            <div className="section-title">
              <span>РРЅРІРµРЅС‚Р°СЂРёР·Р°С†РёСЏ Рё С‚Р°СЂР°</span>
              <span className="tag">{state.containers.length} С‘РјРє.</span>
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
                    <label className="label">РўР°Р±Р°Рє</label>
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
                    <label className="label">РўР°СЂР°</label>
                    <select
                      className="select"
                      value={weighContainer}
                      onChange={(e) => setWeighContainer(e.target.value)}
                    >
                      {state.containers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} В· {c.tareGrams} Рі
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Р’РµСЃ Р±СЂСѓС‚С‚Рѕ, Рі</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={grossGrams}
                      onCommit={setGrossGrams}
                      aria-label="Р’РµСЃ Р±СЂСѓС‚С‚Рѕ, РіСЂР°РјРј"
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
                    <Check size={15} /> РџРµСЂРµСѓС‡РµСЃС‚СЊ
                  </button>
                </div>
                <p className="subhead">
                  Р§РёСЃС‚С‹Р№ РІРµСЃ:{" "}
                  {Math.max(
                    0,
                    grossGrams -
                      (state.containers.find((c) => c.id === weighContainer)
                        ?.tareGrams ?? 0),
                  )}{" "}
                  Рі (Р±СЂСѓС‚С‚Рѕ РјРёРЅСѓСЃ С‚Р°СЂР°).
                </p>
              </>
            ) : (
              <div className="empty">
                Р”РѕР±Р°РІСЊС‚Рµ СЃРєР»Р°РґСЃРєСѓСЋ РїРѕР·РёС†РёСЋ С‚Р°Р±Р°РєР° Рё С‘РјРєРѕСЃС‚СЊ, С‡С‚РѕР±С‹ РІС‹РїРѕР»РЅРёС‚СЊ
                РІР·РІРµС€РёРІР°РЅРёРµ.
              </div>
            )}
            {state.containers.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>РЃРјРєРѕСЃС‚СЊ</th>
                      <th>Р’РµСЃ С‚Р°СЂС‹</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.containers.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="mono">{c.tareGrams} Рі</td>
                        <td>
                          {isAdmin && (
                            <button
                              className="btn btn-quiet btn-sm"
                              aria-label="РЈРґР°Р»РёС‚СЊ С‚Р°СЂСѓ"
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
                    <label className="label">РќР°Р·РІР°РЅРёРµ С‘РјРєРѕСЃС‚Рё</label>
                    <input
                      className="input"
                      value={containerName}
                      onChange={(e) => setContainerName(e.target.value)}
                      placeholder="РќР°РїСЂРёРјРµСЂ, Р±Р°РЅРєР° 1 Р»"
                    />
                  </div>
                  <div>
                    <label className="label">Р’РµСЃ С‚Р°СЂС‹, Рі</label>
                    <NumberField
                      className="input"
                      min="0"
                      value={tare}
                      onCommit={setTare}
                      aria-label="Р’РµСЃ С‚Р°СЂС‹, РіСЂР°РјРј"
                    />
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={createContainer}
                    data-testid="button-add-container"
                  >
                    <Plus size={14} /> Р”РѕР±Р°РІРёС‚СЊ
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {tab === "usage" && (
          <>
            <div className="section-title">
              <span>РЎРїРёСЃР°РЅРёСЏ СЃС‹СЂСЊСЏ Р·Р° РїРµСЂРёРѕРґ</span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {periodPicker}
                <span className="tag">{usageEntries.length} Р·Р°РїРёСЃРµР№</span>
              </div>
            </div>
            <div className="notice" style={{ marginBottom: 12 }}>
              РљР°Р¶РґР°СЏ Р·Р°РєСЂС‹С‚Р°СЏ СЃРјРµРЅР° СЃРїРёСЃС‹РІР°РµС‚ СЃС‹СЂСЊС‘ РїРѕ С„РѕСЂРјСѓР»Р°Рј РёР· РЅР°СЃС‚СЂРѕРµРє Рё
              РїРѕРїР°РґР°РµС‚ РІ Р¶СѓСЂРЅР°Р»: СѓРіРѕР»СЊ вЂ” {usage.coalKgPerHookah} РєРі РЅР° РєР°Р»СЊСЏРЅ Рё{" "}
              {usage.coalKgPerRebuild} РєРі РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ, С‚Р°Р±Р°Рє вЂ” РїРѕ РЅРѕСЂРјРµ С‡Р°С€Рё
              Рё {usage.tobaccoGramsPerRebuild} Рі РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ.
            </div>
            {!usageEntries.length ? (
              <div className="empty">
                Р—Р° РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ СЃРїРёСЃР°РЅРёР№ РЅРµС‚ вЂ” Р¶СѓСЂРЅР°Р» Р·Р°РїРѕР»РЅСЏРµС‚СЃСЏ РїСЂРё
                Р·Р°РєСЂС‹С‚РёРё СЃРјРµРЅ.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>РЎРјРµРЅР°</th>
                      <th>РљР°Р»СЊСЏРЅРѕРІ</th>
                      <th>РџРµСЂРµР·Р°Р±РёРІРѕРє</th>
                      <th>РЈРіРѕР»СЊ</th>
                      <th>РўР°Р±Р°Рє</th>
                      <th>Р¤РѕСЂРјСѓР»Р° СЂР°СЃС‡С‘С‚Р°</th>
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
                              {shift?.master ?? "СЃРјРµРЅР° СѓРґР°Р»РµРЅР° РёР· Р¶СѓСЂРЅР°Р»Р°"}
                            </div>
                          </td>
                          <td className="mono">{entry.hookahCount}</td>
                          <td className="mono">{entry.rebuildCount}</td>
                          <td className="mono">
                            {entry.coalKg.toFixed(3)} РєРі
                          </td>
                          <td className="mono">
                            {Math.round(entry.tobaccoGrams)} Рі
                          </td>
                          <td
                            style={{
                              fontSize: 10,
                              color: "#81858b",
                              lineHeight: 1.6,
                              minWidth: 220,
                            }}
                          >
                            <div>РЈРіРѕР»СЊ: {entry.coalFormula}</div>
                            <div>РўР°Р±Р°Рє: {entry.tobaccoFormula}</div>
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
  // РљРѕСЌС„С„РёС†РёРµРЅС‚С‹ СЃРїРёСЃР°РЅРёСЏ РёР· РЅР°СЃС‚СЂРѕРµРє вЂ” РґР»СЏ СЂР°СЃС…РѕРґР° Р·Р° РїРµСЂРёРѕРґ Рё РїСЂР°РІРєРё СЃРјРµРЅ.
  const usage = resolveUsageSettings(state.usageSettings);
  const [period, setPeriod] = useState<Period>("week");
  const [selectedDate, setSelectedDate] = useState(localDate());
  // РџСѓСЃС‚С‹Рµ Р·РЅР°С‡РµРЅРёСЏ = Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРёР№ РґРёР°РїР°Р·РѕРЅ РЅРµРґРµР»Рё (7 РґРЅРµР№ РґРѕ РІС‹Р±СЂР°РЅРЅРѕР№ РґР°С‚С‹).
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
  // РћС‚РґРµР»СЊРЅС‹Рµ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё РђРјРёРґСѓ РЅРµ РїСЂРёРІСЏР·Р°РЅС‹ Рє СЃРјРµРЅР°Рј, РЅРѕ РІС…РѕРґСЏС‚ РІ Р¤РћРў.
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
  const spanText = `${ruDate(range.from)} вЂ” ${ruDate(range.to)}`;
  // Р’Р»Р°РґРµР»РµС† РїРѕРїР°РґР°РµС‚ РІ СЂР°СЃС‡С‘С‚ РїРѕ РјР°СЃС‚РµСЂР°Рј, РґР°Р¶Рµ РµСЃР»Рё СЃР°Рј РЅРµ СЃС‚РѕСЏР» РІ СЃРјРµРЅРµ:
  // Р·Р° РЅРёРј РјРѕРіСѓС‚ С‡РёСЃР»РёС‚СЊСЃСЏ РѕС‚РґРµР»СЊРЅС‹Рµ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё РёР· amidAdjustments.
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
    if (!previous || !window.confirm("РЈРґР°Р»РёС‚СЊ Р·Р°РїРёСЃСЊ СЃРјРµРЅС‹?")) return;
    const inventory = adjustForShiftChange(state.inventory, previous, null, usage);
    if (!inventory) {
      window.alert("РќРµ СѓРґР°Р»РѕСЃСЊ РІРѕСЃСЃС‚Р°РЅРѕРІРёС‚СЊ РѕСЃС‚Р°С‚РєРё РїРѕ СЌС‚РѕР№ СЃРјРµРЅРµ.");
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
    const inventory = adjustForShiftChange(state.inventory, previous, s, usage);
    if (!inventory) {
      window.alert("РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РѕСЃС‚Р°С‚РєРѕРІ РґР»СЏ РёР·РјРµРЅРµРЅРёР№ СЌС‚РѕР№ СЃРјРµРЅС‹.");
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
          <div className="eyebrow">РЎРІРѕРґРєР° / РёСЃС‚РѕСЂРёСЏ</div>
          <h1>РћС‚С‡С‘С‚С‹</h1>
          <div className="subhead">
            РЎРІРµСЂРєР° РІС‹СЂСѓС‡РєРё, Р·Р°РіСЂСѓР·РєРё Рё СЂР°СЃС‡С‘С‚РѕРІ РєРѕРјР°РЅРґС‹.
          </div>
        </div>
        <div className="tag">
          <TrendingUp size={13} style={{ marginRight: 6 }} />
          РџРµСЂРёРѕРґ: {spanText}
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
            ["day", "Р”РµРЅСЊ"],
            ["week", "РќРµРґРµР»СЏ"],
            ["month", "РњРµСЃСЏС†"],
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
              РЎРІРѕР№ РїРµСЂРёРѕРґ
            </span>
            <input
              aria-label="РќР°С‡Р°Р»Рѕ РїРµСЂРёРѕРґР°"
              className="input"
              style={{ width: 158 }}
              type="date"
              value={range.from}
              onChange={(e) => setWeekFrom(e.target.value)}
              data-testid="input-report-from"
            />
            <span className="label" style={{ margin: 0 }}>
              вЂ”
            </span>
            <input
              aria-label="РљРѕРЅРµС† РїРµСЂРёРѕРґР°"
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
              title="Р’РµСЂРЅСѓС‚СЊ РїРѕСЃР»РµРґРЅРёРµ 7 РґРЅРµР№"
              data-testid="button-reset-range"
            >
              <RotateCcw size={14} /> РЎР±СЂРѕСЃРёС‚СЊ
            </button>
          </div>
        ) : (
          <input
            aria-label="Р”Р°С‚Р° РѕС‚С‡С‘С‚Р°"
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
            <div className="kpi-label">Р’Р«Р РЈР§РљРђ</div>
            <div className="kpi-value">{rub(revenue)}</div>
            <div className="kpi-note">Р·Р° РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ</div>
          </div>
        ) : (
          <div className="card kpi">
            <div className="kpi-label">Р’Р«Р РЈР§РљРђ</div>
            <div className="kpi-value" style={{ fontSize: 20 }}>
              РЎРєСЂС‹С‚Р°
            </div>
            <div className="kpi-note">РЅРµС‚ СЂР°Р·СЂРµС€РµРЅРёСЏ РЅР° РїСЂРѕСЃРјРѕС‚СЂ</div>
          </div>
        )}
        {canRevenue && (
          <div className="card kpi">
            <div className="kpi-label">Р—РђРљРЈРџРљР</div>
            <div className="kpi-value">
              {revenue ? `${((procurementTotal / revenue) * 100).toFixed(1)}%` : "вЂ”"}
            </div>
            <div className="kpi-note">
              РѕС‚ РІС‹СЂСѓС‡РєРё В· {rub(procurementTotal)}
            </div>
          </div>
        )}
        <div className="card kpi">
          <div className="kpi-label">РљРђР›Р¬РЇРќР«</div>
          <div className="kpi-value">{totalHooks}</div>
          <div className="kpi-note">РІСЃРµРіРѕ В· РїРµСЂРµР·Р°Р±РёРІРѕРє {rebuildsTotal}</div>
        </div>
        {canRevenue ? (
          <div className="card kpi">
            <div className="kpi-label">Р¤РћРў</div>
            <div className="kpi-value">
              {revenue ? `${((payrolls / revenue) * 100).toFixed(1)}%` : "вЂ”"}
            </div>
            <div className="kpi-note">
              РґРѕР»СЏ РѕС‚ РІС‹СЂСѓС‡РєРё В· {rub(payrolls)}
            </div>
          </div>
        ) : (
          <div className="card kpi">
            <div className="kpi-label">РЎРњР•РќР«</div>
            <div className="kpi-value">{filtered.length}</div>
            <div className="kpi-note">Р·Р°РєСЂС‹С‚Рѕ Р·Р° РїРµСЂРёРѕРґ</div>
          </div>
        )}
        <div className="card kpi">
          <div className="kpi-label">Р РђРЎРҐРћР” РўРђР‘РђРљРђ</div>
          <div className="kpi-value">{tobaccoUsed} Рі</div>
          <div className="kpi-note">
            РЈРіРѕР»СЊ:{" "}
            {filtered
              .reduce(
                (n, s) => n + calcCoalUsageKg(s.lines.length, s.rebuilds ?? 0, usage),
                0,
              )
              .toFixed(2)}{" "}
            РєРі
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
            <span>РљР°С‚РµРіРѕСЂРёРё РєР°Р»СЊСЏРЅРѕРІ</span>
            <span className="tag">
              {cats.reduce((n, c) => n + c.count, 0)} С€С‚.
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
                      {cat.count} В·{" "}
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
            <div className="empty">Р’ РїРµСЂРёРѕРґРµ РїРѕРєР° РЅРµС‚ РїСЂРѕРґР°Р¶.</div>
          )}
          {canRevenue && (
            <>
              <div className="divider" />
              <div className="section-title">
                <span>Р Р°СЃС‡С‘С‚ РїРѕ РјР°СЃС‚РµСЂР°Рј</span>
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
                        {rows.length} СЃРјРµРЅ
                        {adjustmentCount > 0
                          ? ` В· ${adjustmentCount} РѕС‚РґРµР»СЊРЅС‹С… РґРѕРїР»Р°С‚`
                          : ""}
                      </span>
                    </span>
                    <b className="mono" style={{ color: "#ddc16f" }}>
                      {rub(earned)}{" "}
                      <small style={{ color: "#81858b" }}>
                        В·{" "}
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
                <span>Р”РѕРї. РІС‹РїР»Р°С‚С‹ РїРѕРјРѕС‰РЅРёРєР°Рј</span>
                <b className="mono">{rub(helpersTotal)}</b>
              </div>
            </>
          )}
        </div>
        <div className="card">
          <div className="section-title">
            <span>РЎРєРёРґРєРё Рё РїСЂРёС‡РёРЅС‹</span>
            <span className="tag">{discounts.length} СЃР»СѓС‡Р°РµРІ</span>
          </div>
          {discounts.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>РЎРјРµРЅР°</th>
                    <th>РџРѕР·РёС†РёСЏ</th>
                    <th>РЎРєРёРґРєР°</th>
                    <th>РџСЂРёС‡РёРЅР°</th>
                  </tr>
                </thead>
                <tbody>
                  {discounts.map(({ shift, line }) => (
                    <tr key={line.id}>
                      <td>{ruDate(shift.date)}</td>
                      <td>{line.menuItemName}</td>
                      <td className="mono">
                        {line.discount}% В· в€’
                        {rub((line.unitPrice * line.discount) / 100)}
                      </td>
                      <td>{line.reason || "вЂ”"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">Р’ РІС‹Р±СЂР°РЅРЅРѕРј РїРµСЂРёРѕРґРµ СЃРєРёРґРѕРє РЅРµС‚.</div>
          )}
        </div>
      </div>
      <div className="card" style={{ marginTop: 17 }}>
        <div className="section-title">
          <span>РСЃС‚РѕСЂРёСЏ СЃРјРµРЅ</span>
          <span className="tag">{filtered.length} Р·Р°РїРёСЃРµР№</span>
        </div>
        {filtered.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Р”Р°С‚Р°</th>
                  <th>РњР°СЃС‚РµСЂ</th>
                  <th>РљР°Р»СЊСЏРЅС‹</th>
                  {canRevenue && (
                    <>
                      <th>Р’С‹СЂСѓС‡РєР°</th>
                      <th>РќР°С‡РёСЃР»РµРЅРѕ</th>
                      <th>Р—Р°РєСѓРїРєРё</th>
                    </>
                  )}
                  <th>РљРѕРјРјРµРЅС‚Р°СЂРёР№</th>
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
                      <td>{s.comment || "вЂ”"}</td>
                      <td>
                        {mayEdit && (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              className="btn btn-quiet btn-sm"
                              title="РР·РјРµРЅРёС‚СЊ Р·Р°РїРёСЃСЊ"
                              onClick={() => setEditing(s)}
                              data-testid={`button-edit-shift-${s.id}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="btn btn-quiet btn-sm btn-danger"
                              title="РЈРґР°Р»РёС‚СЊ Р·Р°РїРёСЃСЊ"
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
            РќРµС‚ СЃРјРµРЅ Р·Р° РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ. РќРѕРІС‹Рµ Р·Р°РїРёСЃРё РїРѕСЏРІСЏС‚СЃСЏ РїРѕСЃР»Рµ СЃРѕС…СЂР°РЅРµРЅРёСЏ
            СЃРјРµРЅС‹.
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
  // РџСЂРѕС†РµРЅС‚ РІ СЃРѕРІРјРµСЃС‚РЅРѕР№ СЃРјРµРЅРµ РґРµР»РёС‚СЃСЏ РїРѕСЂРѕРІРЅСѓ РјРµР¶РґСѓ СѓС‡Р°СЃС‚РЅРёРєР°РјРё, РѕРєР»Р°Рґ Сѓ
  // РєР°Р¶РґРѕРіРѕ СЃРІРѕР№ вЂ” Р»РѕРіРёРєР° Р¶РёРІС‘С‚ РІ calcMasterShiftPayout Рё РїРѕРєСЂС‹С‚Р° С‚РµСЃС‚Р°РјРё.
  // РћС‚РґРµР»СЊРЅС‹Рµ РєРѕСЂСЂРµРєС‚РёСЂРѕРІРєРё РІР»Р°РґРµР»СЊС†Сѓ (amidAdjustments) СЃСЋРґР° РЅРµ РІС…РѕРґСЏС‚.
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
        <div className="section-title"><span>РР·РјРµРЅРёС‚СЊ СЃРјРµРЅСѓ</span><button className="btn btn-quiet btn-sm" onClick={onClose}><X size={16} /></button></div>
        <label className="label">Р”Р°С‚Р°</label>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label className="label" style={{ marginTop: 12 }}>РЎРѕС‚СЂСѓРґРЅРёРєРё</label>
        <div className="employee-picker" role="group" aria-label="РЎРѕС‚СЂСѓРґРЅРёРєРё СЃРјРµРЅС‹">
          {employees.map((employee) => (
            <label key={employee.id} className={`employee-option ${selectedEmployees.includes(employee.name) ? "selected" : ""}`}>
              <input type="checkbox" checked={selectedEmployees.includes(employee.name)} onChange={() => toggleEmployee(employee.name)} aria-label={employee.name} />
              <span>{employee.name}</span>
            </label>
          ))}
        </div>
        {selectedEmployees.length === 1 && <><label className="label" style={{ marginTop: 12 }}>РћРєР»Р°Рґ СЌС‚РѕР№ СЃРјРµРЅС‹, в‚Ѕ</label><input className="input" type="number" min="0" value={fixed} onChange={(e) => setFixed(e.target.value === "" ? "" : Number(e.target.value))} /></>}
        {canEditPurchase && <><label className="label" style={{ marginTop: 12 }}>Р—Р°РєСѓРїРєР°, в‚Ѕ</label><NumberField className="input" min="0" step="1" value={purchaseAmount} onCommit={(next) => setPurchaseAmount(Math.max(0, next))} data-testid="input-edit-purchase-amount" /></>}
        <label className="label" style={{ marginTop: 12 }}>РљРѕРјРјРµРЅС‚Р°СЂРёР№</label>
        <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onClose}>РћС‚РјРµРЅР°</button>
          <button className="btn btn-primary" onClick={() => onSave({ ...shift, date, master, comment, fixedSalary: fixed === "" ? null : Number(fixed), purchaseAmount })}><Check size={14} /> РЎРѕС…СЂР°РЅРёС‚СЊ</button>
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
  // РЎРјРµРЅР° РєР»СЋС‡Р° СЃР±СЂР°СЃС‹РІР°РµС‚ С‡РµСЂРЅРѕРІРёРє РІРІРѕРґР° РІ РїРѕР»СЏС… С„РѕСЂРјС‹ РЅРѕРІРѕРіРѕ СЃРѕС‚СЂСѓРґРЅРёРєР°.
  const [employeeFormKey, setEmployeeFormKey] = useState(0);
  // Р§РµСЂРЅРѕРІРёРє РєРѕСЌС„С„РёС†РёРµРЅС‚РѕРІ СЃРїРёСЃР°РЅРёСЏ СЃС‹СЂСЊСЏ: РєР°СЂС‚РѕС‡РєР° В«Р Р°СЃС…РѕРґ СЃС‹СЂСЊСЏВ».
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
            <div className="eyebrow">РЈРїСЂР°РІР»РµРЅРёРµ РґРѕСЃС‚СѓРїРѕРј</div>
            <h1>РќР°СЃС‚СЂРѕР№РєРё</h1>
          </div>
        </div>
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="notice">
            Р Р°Р·РґРµР» РґРѕСЃС‚СѓРїРµРЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ. Р”Р»СЏ РЅР°СЃС‚СЂРѕР№РєРё РјРµРЅСЋ Рё РїСЂР°РІ РѕР±СЂР°С‚РёС‚РµСЃСЊ
            Рє СѓРїСЂР°РІР»СЏСЋС‰РµРјСѓ.
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
  // РЎРѕС…СЂР°РЅРµРЅРёРµ РєРѕСЌС„С„РёС†РёРµРЅС‚РѕРІ СЃРїРёСЃР°РЅРёСЏ: РїРёС€СѓС‚СЃСЏ РІ Р‘Р” С‡РµСЂРµР· РѕР±С‰РёР№ PUT /pos/state
  // Рё РїСЂРёРјРµРЅСЏСЋС‚СЃСЏ РєРѕ РІСЃРµРј РЅРѕРІС‹Рј РѕРїРµСЂР°С†РёСЏРј (СЃРјРµРЅС‹, РѕС‚С‡С‘С‚С‹, Р¶СѓСЂРЅР°Р»).
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
  // РћР±С‰РёР№ РїСѓС‚СЊ СЃРѕС…СЂР°РЅРµРЅРёСЏ РјРµРЅСЋ: Рё РєРЅРѕРїРєР° В«РЎРѕС…СЂР°РЅРёС‚СЊ РјРµРЅСЋВ», Рё Р±С‹СЃС‚СЂРѕРµ РґРѕР±Р°РІР»РµРЅРёРµ
  // В«+В» С€Р»СѓС‚ РѕРґРёРЅ Рё С‚РѕС‚ Р¶Рµ PUT /pos/state РІРјРµСЃС‚Рµ СЃ РїСЂР°РІР°РјРё РЅР° РЅРѕРІС‹Рµ РїРѕР·РёС†РёРё вЂ”
  // РёРЅР°С‡Рµ РЅРѕРІР°СЏ РїРѕР·РёС†РёСЏ Р¶РёР»Р° Р±С‹ С‚РѕР»СЊРєРѕ РІ С‡РµСЂРЅРѕРІРёРєРµ Рё РїСЂРѕРїР°РґР°Р»Р° РїСЂРё СѓС…РѕРґРµ СЃРѕ
  // СЃС‚СЂР°РЅРёС†С‹ (С‡РµСЂРЅРѕРІРёРє РІРѕСЃСЃС‚Р°РЅР°РІР»РёРІР°РµС‚СЃСЏ РёР· state.menu).
  const persistMenu = (items: MenuItem[], onSuccess?: () => void) => {
    const issues = validateMenuItems(items);
    if (issues.length) {
      window.alert(
        `РџСЂРѕРІРµСЂСЊС‚Рµ РјРµРЅСЋ РїРµСЂРµРґ СЃРѕС…СЂР°РЅРµРЅРёРµРј:\n${issues
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
    // РЎРѕСЃС‚РѕСЏРЅРёРµ СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ С†РµР»РёРєРѕРј: РѕРґРЅР° РЅРµРіРѕРґРЅР°СЏ РїРѕР·РёС†РёСЏ РѕС‚РєР»РѕРЅСЏРµС‚ Р·Р°РїРёСЃСЊ
    // РјРµРЅСЋ, СЃРєР»Р°РґР° Рё СЃРјРµРЅ, РїРѕСЌС‚РѕРјСѓ РїСЂРѕРІРµСЂСЏРµРј РЅРѕРІСѓСЋ РїРѕР·РёС†РёСЋ СЃСЂР°Р·Сѓ.
    const issues = validateMenuItems([draft]);
    if (issues.length) {
      window.alert(`РџРѕР·РёС†РёСЏ РЅРµ РґРѕР±Р°РІР»РµРЅР°: ${issues.map((issue) => issue.message).join("; ")}.`);
      return;
    }
    const nextMenu = [...menuDraft, draft];
    // РћРїС‚РёРјРёСЃС‚РёС‡РЅРѕ РїРѕРєР°Р·С‹РІР°РµРј СЃС‚СЂРѕРєСѓ РІ СЃРїРёСЃРєРµ, РЅРѕ СЃРѕС…СЂР°РЅСЏРµРј СЃСЂР°Р·Сѓ: С‚Р°Рє РїРѕР·РёС†РёСЏ
    // РїРѕРїР°РґР°РµС‚ Рё РІ Р±Р°Р·Сѓ, Рё РІ РїР»РёС‚РєРё РјРµРЅСЋ СЃРѕС‚СЂСѓРґРЅРёРєР° Р±РµР· РѕС‚РґРµР»СЊРЅРѕРіРѕ В«РЎРѕС…СЂР°РЅРёС‚СЊ
    // РјРµРЅСЋВ». РџРѕР»СЏ С„РѕСЂРјС‹ РѕС‡РёС‰Р°СЋС‚СЃСЏ С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ СѓСЃРїРµС€РЅРѕРіРѕ РѕС‚РІРµС‚Р° СЃРµСЂРІРµСЂР°.
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
        "РЈРґР°Р»РёС‚СЊ РїРѕР·РёС†РёСЋ РјРµРЅСЋ? РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃРјРµРЅС‹ РѕСЃС‚Р°РЅСѓС‚СЃСЏ РІ РёСЃС‚РѕСЂРёРё.",
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
    menuIssueLines.length > 3 ? ` Рё РµС‰С‘ ${menuIssueLines.length - 3}` : ""
  }`;
  const saveMenu = () => persistMenu(menuDraft);
  const updateEmployee = (id: string, patch: Partial<Employee>) =>
    setEmployeeDraft((draft) => draft.map((employee) => employee.id === id ? { ...employee, ...patch } : employee));
  const addEmployee = () => {
    const name = newEmployeeName.trim();
    if (!name || /[+/]/.test(name) || employeeDraft.some((employee) => employee.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU"))) {
      window.alert("РЈРєР°Р¶РёС‚Рµ СѓРЅРёРєР°Р»СЊРЅРѕРµ РёРјСЏ СЃРѕС‚СЂСѓРґРЅРёРєР° Р±РµР· СЃРёРјРІРѕР»РѕРІ + Рё /.");
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
      window.alert("РќРµР»СЊР·СЏ СѓРґР°Р»РёС‚СЊ РїРѕСЃР»РµРґРЅРµРіРѕ СЃРѕС‚СЂСѓРґРЅРёРєР°.");
      return;
    }
    if (state.shifts.some((shift) => shift.master.split(/\s*[+/]\s*/).includes(employee.name))) {
      window.alert("РќРµР»СЊР·СЏ СѓРґР°Р»РёС‚СЊ СЃРѕС‚СЂСѓРґРЅРёРєР°, РїРѕРєР° РµРіРѕ СЃРјРµРЅС‹ РµСЃС‚СЊ РІ РёСЃС‚РѕСЂРёРё.");
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
      window.alert("РРјРµРЅР° СЃРѕС‚СЂСѓРґРЅРёРєРѕРІ РґРѕР»Р¶РЅС‹ Р±С‹С‚СЊ РЅРµРїСѓСЃС‚С‹РјРё, СѓРЅРёРєР°Р»СЊРЅС‹РјРё Рё Р±РµР· СЃРёРјРІРѕР»РѕРІ + Рё /.");
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
      "РџСЂРѕСЃРјРѕС‚СЂ РІС‹СЂСѓС‡РєРё",
      "Р Р°Р·СЂРµС€РёС‚СЊ СЃРѕС‚СЂСѓРґРЅРёРєР°Рј РІРёРґРµС‚СЊ СЃСѓРјРјС‹ РїСЂРѕРґР°Р¶ Рё Р·Р°СЂРїР»Р°С‚С‹.",
    ],
    [
      "useDiscounts",
      "РЎРєРёРґРєРё РїСЂРё РІРІРѕРґРµ СЃРјРµРЅС‹",
      "РЎРѕС‚СЂСѓРґРЅРёРєРё РјРѕРіСѓС‚ РїСЂРёРјРµРЅРёС‚СЊ СЃРєРёРґРєСѓ 50% РёР»Рё 100% Рё СѓРєР°Р·Р°С‚СЊ РїСЂРёС‡РёРЅСѓ.",
    ],
    [
      "addInventory",
      "РџСЂРёС‘РјРєР° С‚РѕРІР°СЂР°",
      "Р Р°Р·СЂРµС€РёС‚СЊ РІРЅРѕСЃРёС‚СЊ РїРѕСЃС‚Р°РІРєРё. РљР°С‚Р°Р»РѕРі СЃРєР»Р°РґСЃРєРёС… РїРѕР·РёС†РёР№ РјРµРЅСЏРµС‚ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ.",
    ],
    [
      "editPastInventory",
      "РџРµСЂРµСѓС‡С‘С‚ СЃРєР»Р°РґР°",
      "Р Р°Р·СЂРµС€РёС‚СЊ РёСЃРїСЂР°РІР»РµРЅРёРµ С„Р°РєС‚РёС‡РµСЃРєРёС… РѕСЃС‚Р°С‚РєРѕРІ Рё РЅР°С‡Р°Р»СЊРЅРѕРіРѕ Р±Р°Р»Р°РЅСЃР° СѓРіР»СЏ.",
    ],
    [
      "editPastShifts",
      "РџСЂР°РІРєР° РёСЃС‚РѕСЂРёРё СЃРјРµРЅ",
      "Р Р°Р·СЂРµС€РёС‚СЊ РјРµРЅСЏС‚СЊ Рё СѓРґР°Р»СЏС‚СЊ Р·Р°РїРёСЃРё РїСЂРѕС€РµРґС€РёС… СЃРјРµРЅ.",
    ],
  ];
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">РђРґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ / РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ</div>
          <h1>РќР°СЃС‚СЂРѕР№РєРё С‚РµСЂРјРёРЅР°Р»Р°</h1>
          <div className="subhead">
            РњРµРЅСЋ РїСЂРѕРґР°Р¶ Рё РґРѕСЃС‚СѓРї СЃРѕС‚СЂСѓРґРЅРёРєР° Рє С„СѓРЅРєС†РёСЏРј.
          </div>
        </div>
        <div className="tag gold">
          <ShieldCheck size={14} style={{ marginRight: 6 }} />
          РџРѕР»РЅС‹Р№ РґРѕСЃС‚СѓРї
        </div>
      </div>
      {saveError && (
        <div className="notice" style={{ marginBottom: 14, color: "#df897d" }} role="alert">
          РЎРµСЂРІРµСЂ РЅРµ СЃРѕС…СЂР°РЅРёР» РґР°РЅРЅС‹Рµ: {saveError}
        </div>
      )}
      <div className="card" style={{ marginBottom: 17 }}>
        <div className="section-title">
          <span>Р Р°СЃС…РѕРґ СЃС‹СЂСЊСЏ (Р°РІС‚РѕСЃРїРёСЃР°РЅРёРµ)</span>
          <Flame size={16} color="#b99b58" />
        </div>
        <div className="notice" style={{ marginBottom: 14 }}>
          РљРѕСЌС„С„РёС†РёРµРЅС‚С‹ С…СЂР°РЅСЏС‚СЃСЏ РІ Р±Р°Р·Рµ РґР°РЅРЅС‹С… Рё РїСЂРёРјРµРЅСЏСЋС‚СЃСЏ РєРѕ РІСЃРµРј РЅРѕРІС‹Рј
          РѕРїРµСЂР°С†РёСЏРј СЃСЂР°Р·Сѓ РїРѕСЃР»Рµ СЃРѕС…СЂР°РЅРµРЅРёСЏ: СЃРјРµРЅС‹, РѕС‚С‡С‘С‚С‹ Рё Р¶СѓСЂРЅР°Р» СЃРїРёСЃР°РЅРёР№
          СЃС‡РёС‚Р°СЋС‚ РїРѕ РЅРёРј. РЈР¶Рµ Р·Р°РєСЂС‹С‚С‹Рµ СЃРјРµРЅС‹ СЃРѕС…СЂР°РЅСЏСЋС‚ С„РѕСЂРјСѓР»Сѓ, СЃ РєРѕС‚РѕСЂРѕР№ Р±С‹Р»Рё
          СЃРїРёСЃР°РЅС‹.
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
            gap: 12,
          }}
        >
          <div>
            <label className="label">РЈРіРѕР»СЊ РЅР° РєР°Р»СЊСЏРЅ, РєРі</label>
            <NumberField
              className="input"
              min="0"
              step="0.001"
              value={usageDraft.coalKgPerHookah}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, coalKgPerHookah: next })
              }
              aria-label="РљРёР»РѕРіСЂР°РјРјРѕРІ СѓРіР»СЏ РЅР° РєР°Р»СЊСЏРЅ"
              data-testid="input-usage-coal-per-hookah"
              disabled={saving}
            />
          </div>
          <div>
            <label className="label">РЈРіРѕР»СЊ РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ, РєРі</label>
            <NumberField
              className="input"
              min="0"
              step="0.001"
              value={usageDraft.coalKgPerRebuild}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, coalKgPerRebuild: next })
              }
              aria-label="РљРёР»РѕРіСЂР°РјРјРѕРІ СѓРіР»СЏ РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ"
              data-testid="input-usage-coal-per-rebuild"
              disabled={saving}
            />
          </div>
          <div>
            <label className="label">РўР°Р±Р°Рє РЅР° Р·Р°Р±РёРІ/РїРµСЂРµР·Р°Р±РёРІРєСѓ, Рі</label>
            <NumberField
              className="input"
              min="0"
              step="1"
              value={usageDraft.tobaccoGramsPerRebuild}
              onCommit={(next) =>
                setUsageDraft({ ...usageDraft, tobaccoGramsPerRebuild: next })
              }
              aria-label="Р“СЂР°РјРјРѕРІ С‚Р°Р±Р°РєР° РЅР° РїРµСЂРµР·Р°Р±РёРІРєСѓ"
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
          {usageDirty && <span className="saving">Р•СЃС‚СЊ РЅРµСЃРѕС…СЂР°РЅС‘РЅРЅС‹Рµ РёР·РјРµРЅРµРЅРёСЏ</span>}
          <button
            className="btn btn-primary"
            onClick={saveUsageSettings}
            disabled={saving || !usageDirty}
            data-testid="button-save-usage-settings"
          >
            <Check size={14} /> {saving ? "РЎРѕС…СЂР°РЅСЏРµРјвЂ¦" : "РЎРѕС…СЂР°РЅРёС‚СЊ РїСЂР°РІРёР»Р°"}
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
            <span>РњРµРЅСЋ РєР°Р»СЊСЏРЅРѕРІ</span>
            <span className="tag">{menuDraft.length} РїРѕР·РёС†РёР№</span>
          </div>
          {!state.menu.some((item) => item.id === BARBIE_MENU_ITEM.id) && (
            <div className="notice" style={{ marginBottom: 12 }}>
              РР· С‚Р°Р±Р»РёС†С‹ РґРѕР±Р°РІР»РµРЅР° РїРѕР·РёС†РёСЏ В«Р‘Р°СЂР±РёВ». РЈРєР°Р¶РёС‚Рµ РµС‘ С†РµРЅСѓ Рё РІРєР»СЋС‡РёС‚Рµ РІ РјРµРЅСЋ РїРµСЂРµРґ СЃРѕС…СЂР°РЅРµРЅРёРµРј.
            </div>
          )}
          {menuIssues.length > 0 && (
            <div className="notice" style={{ marginBottom: 12, color: "#df897d" }}>
              РџРѕР·РёС†РёРё РЅРµ СЃРѕС…СЂР°РЅСЏС‚СЃСЏ, РїРѕРєР° РЅРµ РёСЃРїСЂР°РІР»РµРЅРѕ: {menuIssueSummary}.
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
                aria-label="РќР°Р·РІР°РЅРёРµ РїРѕР·РёС†РёРё"
                data-testid={`input-menu-name-${item.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={item.price}
                onCommit={(next) => updateItem(item.id, { price: next })}
                aria-label={`Р¦РµРЅР° РїРѕР·РёС†РёРё ${item.name}, СЂСѓР±Р»РµР№`}
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
                  aria-label="РўР°Р±Р°Рє, РіСЂР°РјРј"
                  disabled={saving}
                />
                <small style={{ color: "#777" }}>Рі</small>
              </div>
              <NumberField
                className="input"
                min="0"
                value={item.salaryBonus ?? getMenuSalaryBonus(state.menu as MenuItemWithBonus[], item.id)}
                onCommit={(next) => updateItem(item.id, { salaryBonus: next })}
                aria-label={`Р”РѕРїР»Р°С‚Р° Р·Р° ${item.name}, СЂСѓР±Р»РµР№`}
                data-testid={`input-menu-salary-bonus-${item.id}`}
                disabled={saving}
              />
              <button
                className={`btn btn-sm ${item.enabled ? "" : "btn-quiet"}`}
                onClick={() => updateItem(item.id, { enabled: !item.enabled })}
                data-testid={`button-toggle-menu-${item.id}`}
                disabled={saving}
              >
                {item.enabled ? "Р’ РјРµРЅСЋ" : "РЎРєСЂС‹С‚Р°"}
              </button>
              <button
                className="btn btn-quiet btn-sm btn-danger"
                onClick={() => removeItem(item.id)}
                aria-label="РЈРґР°Р»РёС‚СЊ РїРѕР·РёС†РёСЋ"
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
            <span>Р”РѕР±Р°РІРёС‚СЊ РїРѕР·РёС†РёСЋ</span>
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
              <label className="label">РќР°Р·РІР°РЅРёРµ</label>
              <input
                className="input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="РќРѕРІРёРЅРєР°"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">Р¦РµРЅР°</label>
              <NumberField
                className="input"
                min="0"
                step="1"
                value={newPrice}
                onCommit={setNewPrice}
                aria-label="Р¦РµРЅР° РЅРѕРІРѕР№ РїРѕР·РёС†РёРё, СЂСѓР±Р»РµР№"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">РўР°Р±Р°Рє, Рі ({MIN_TOBACCO_GRAMS}вЂ“{MAX_TOBACCO_GRAMS})</label>
              <NumberField
                className="input"
                min={MIN_TOBACCO_GRAMS}
                max={MAX_TOBACCO_GRAMS}
                step="1"
                value={newGrams}
                onCommit={setNewGrams}
                aria-label="РўР°Р±Р°Рє РЅРѕРІРѕР№ РїРѕР·РёС†РёРё, РіСЂР°РјРј"
                disabled={saving}
              />
            </div>
            <div>
              <label className="label">Р”РѕРїР»Р°С‚Р°, в‚Ѕ</label>
              <NumberField
                className="input"
                min="0"
                value={newSalaryBonus}
                onCommit={setNewSalaryBonus}
                aria-label="Р”РѕРїР»Р°С‚Р° РЅРѕРІРѕР№ РїРѕР·РёС†РёРё, СЂСѓР±Р»РµР№"
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
              <Check size={14} /> {saving ? "РЎРѕС…СЂР°РЅСЏРµРјвЂ¦" : "РЎРѕС…СЂР°РЅРёС‚СЊ РјРµРЅСЋ"}
            </button>
          </div>
        </div>
        <div className="grid">
          <div className="card">
            <div className="section-title">
              <span>РџСЂР°РІР° СЃРѕС‚СЂСѓРґРЅРёРєР°</span>
              <Users size={16} color="#b99b58" />
            </div>
            <div className="notice" style={{ marginBottom: 14 }}>
              РќР°СЃС‚СЂРѕР№РєРё РїСЂРёРјРµРЅСЏСЋС‚СЃСЏ Рє СЂРѕР»Рё В«РЎРѕС‚СЂСѓРґРЅРёРєВ» СЃСЂР°Р·Сѓ РїРѕСЃР»Рµ СЃРѕС…СЂР°РЅРµРЅРёСЏ.
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
              <span>Р”РѕСЃС‚СѓРїРЅС‹Рµ РїРѕР·РёС†РёРё</span>
              <ChevronRight size={16} color="#858990" />
            </div>
            <p className="subhead" style={{ marginTop: -8, marginBottom: 14 }}>
              Р§С‚Рѕ СЃРѕС‚СЂСѓРґРЅРёРє СѓРІРёРґРёС‚ РІ РёРЅС‚РµСЂС„РµР№СЃРµ РІРІРѕРґР° СЃРјРµРЅС‹.
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
          <span>РЎРѕС‚СЂСѓРґРЅРёРєРё Рё Р·Р°СЂРїР»Р°С‚С‹</span>
          <Users size={16} color="#b99b58" />
        </div>
        <p className="subhead" style={{ marginTop: -8, marginBottom: 14 }}>
          РЈ РєР°Р¶РґРѕРіРѕ СЃРІРѕР№ РѕРєР»Р°Рґ Р·Р° СЃРјРµРЅСѓ Рё СЃС‚Р°РІРєР° РїРѕСЃР»Рµ 30 РєР°Р»СЊСЏРЅРѕРІ. Р”РѕРїР»Р°С‚Р° РјРµРЅСЋ РґРµР»РёС‚СЃСЏ РїРѕСЂРѕРІРЅСѓ РјРµР¶РґСѓ РІС‹Р±СЂР°РЅРЅС‹РјРё СЃРѕС‚СЂСѓРґРЅРёРєР°РјРё.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) 36px", gap: 9, paddingBottom: 5 }}>
          <span className="label">РЎРѕС‚СЂСѓРґРЅРёРє</span>
          <span className="label">РћРєР»Р°Рґ Р·Р° СЃРјРµРЅСѓ, в‚Ѕ</span>
          <span className="label">РЎРІС‹С€Рµ 30 РєР°Р»СЊСЏРЅРѕРІ, в‚Ѕ</span>
          <span />
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {employeeDraft.map((employee) => (
            <div key={employee.id} style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) 36px", gap: 9, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #2b2d32" }}>
              <input
                className="input"
                value={employee.name}
                onChange={(e) => updateEmployee(employee.id, { name: e.target.value })}
                aria-label={`РРјСЏ СЃРѕС‚СЂСѓРґРЅРёРєР° ${employee.name}`}
                data-testid={`input-employee-name-${employee.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={employee.baseSalary}
                onCommit={(next) => updateEmployee(employee.id, { baseSalary: Math.max(0, next) })}
                aria-label={`РћРєР»Р°Рґ ${employee.name}, СЂСѓР±Р»РµР№`}
                data-testid={`input-employee-salary-${employee.id}`}
                disabled={saving}
              />
              <NumberField
                className="input"
                min="0"
                step="1"
                value={employee.highVolumeSalary}
                onCommit={(next) => updateEmployee(employee.id, { highVolumeSalary: Math.max(0, next) })}
                aria-label={`РћРєР»Р°Рґ ${employee.name} СЃРІС‹С€Рµ 30 РєР°Р»СЊСЏРЅРѕРІ, СЂСѓР±Р»РµР№`}
                data-testid={`input-employee-high-salary-${employee.id}`}
                disabled={saving}
              />
              <button className="btn btn-quiet btn-sm btn-danger" onClick={() => removeEmployee(employee)} aria-label={`РЈРґР°Р»РёС‚СЊ ${employee.name}`} disabled={saving}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: "minmax(120px,1fr) minmax(110px,160px) minmax(120px,180px) auto", gap: 9, alignItems: "end", marginTop: 13 }}>
          <div>
            <label className="label">РќРѕРІС‹Р№ СЃРѕС‚СЂСѓРґРЅРёРє</label>
            <input className="input" value={newEmployeeName} onChange={(e) => setNewEmployeeName(e.target.value)} placeholder="РРјСЏ" disabled={saving} />
          </div>
          <div>
            <label className="label">РћРєР»Р°Рґ, в‚Ѕ</label>
            <NumberField className="input" min="0" step="1" key={`new-salary-${employeeFormKey}`} value={newEmployeeSalary} disabled={saving} aria-label="РћРєР»Р°Рґ РЅРѕРІРѕРіРѕ СЃРѕС‚СЂСѓРґРЅРёРєР°, СЂСѓР±Р»РµР№" onCommit={(salary) => {
              const next = Math.max(0, salary);
              setNewEmployeeSalary(next);
              setNewEmployeeHighVolumeSalary((current) => current === 0 ? next : current);
            }} />
          </div>
          <div>
            <label className="label">РЎРІС‹С€Рµ 30, в‚Ѕ</label>
            <NumberField className="input" min="0" step="1" key={`new-high-${employeeFormKey}`} value={newEmployeeHighVolumeSalary} aria-label="РћРєР»Р°Рґ РЅРѕРІРѕРіРѕ СЃРѕС‚СЂСѓРґРЅРёРєР° СЃРІС‹С€Рµ 30 РєР°Р»СЊСЏРЅРѕРІ, СЂСѓР±Р»РµР№" onCommit={(next) => setNewEmployeeHighVolumeSalary(Math.max(0, next))} disabled={saving} />
          </div>
          <button className="btn btn-primary" onClick={addEmployee} aria-label="Р”РѕР±Р°РІРёС‚СЊ СЃРѕС‚СЂСѓРґРЅРёРєР°" disabled={saving || !newEmployeeName.trim()}>
            <Plus size={14} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 13 }}>
          <button className="btn btn-primary" onClick={saveEmployees} disabled={saving || !employeesDirty || !employeesValid} data-testid="button-save-employees">
            <Check size={14} /> {saving ? "РЎРѕС…СЂР°РЅСЏРµРјвЂ¦" : "РЎРѕС…СЂР°РЅРёС‚СЊ СЃРѕС‚СЂСѓРґРЅРёРєРѕРІ"}
          </button>
        </div>
      </div>
      <div className="card" style={{ marginTop: 17 }}>
        <div className="section-title">
          <span>РўР°СЂРёС„С‹ Рё СЂР°СЃС‡С‘С‚</span>
          <Flame size={16} color="#b99b58" />
        </div>
        <p className="subhead" style={{ marginTop: -6, marginBottom: 12 }}>
          Р¦РµРЅР°, РіСЂР°РјРјРѕРІРєР° С‚Р°Р±Р°РєР° Рё РґРѕРїР»Р°С‚Р° РєР°Р¶РґРѕР№ РїРѕР·РёС†РёРё вЂ” РїСЂР°РІСЏС‚СЃСЏ РїСЂСЏРјРѕ Р·РґРµСЃСЊ.
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
              <span className="label">РџРѕР·РёС†РёСЏ</span>
              <span className="label">Р¦РµРЅР°, в‚Ѕ</span>
              <span className="label">РўР°Р±Р°Рє, Рі</span>
              <span className="label">Р”РѕРїР»Р°С‚Р°, в‚Ѕ</span>
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
                    aria-label={`РќР°Р·РІР°РЅРёРµ РїРѕР·РёС†РёРё ${item.name}`}
                    data-testid={`input-tariff-name-${item.id}`}
                    disabled={saving}
                  />
                  <NumberField
                    className="input"
                    min="0"
                    step="1"
                    value={item.price}
                    onCommit={(next) => updateItem(item.id, { price: next })}
                    aria-label={`Р¦РµРЅР° РїРѕР·РёС†РёРё ${item.name}, СЂСѓР±Р»РµР№`}
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
                    aria-label={`РўР°Р±Р°Рє РїРѕР·РёС†РёРё ${item.name}, РіСЂР°РјРј`}
                    data-testid={`input-tariff-grams-${item.id}`}
                    disabled={saving}
                  />
                  <NumberField
                    className="input"
                    min="0"
                    value={item.salaryBonus ?? getMenuSalaryBonus(state.menu as MenuItemWithBonus[], item.id)}
                    onCommit={(next) => updateItem(item.id, { salaryBonus: next })}
                    aria-label={`Р”РѕРїР»Р°С‚Р° Р·Р° ${item.name}, СЂСѓР±Р»РµР№`}
                    data-testid={`input-tariff-bonus-${item.id}`}
                    disabled={saving}
                  />
                </div>
                {!item.enabled && (
                  <div style={{ color: "#8b8f96", fontSize: 10, paddingBottom: 6 }}>
                    РџРѕР·РёС†РёСЏ СЃРєСЂС‹С‚Р° РёР· РјРµРЅСЋ вЂ” РІРєР»СЋС‡Р°РµС‚СЃСЏ РІ СЃРїРёСЃРєРµ В«РњРµРЅСЋ РєР°Р»СЊСЏРЅРѕРІВ».
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
          <div className="empty">РџРѕР·РёС†РёРё РјРµРЅСЋ РїРѕРєР° РЅРµ Р·Р°РґР°РЅС‹.</div>
        )}
        <p className="subhead" style={{ fontSize: 11, lineHeight: 1.6 }}>
          РР·РјРµРЅРµРЅРёСЏ РїСЂРёРјРµРЅСЏСЋС‚СЃСЏ РєРЅРѕРїРєРѕР№ В«РЎРѕС…СЂР°РЅРёС‚СЊ РјРµРЅСЋВ». РС‚РѕРі СЃРјРµРЅС‹ = РѕРєР»Р°РґС‹
          РјР°СЃС‚РµСЂРѕРІ + РІСЃСЏ РґРѕРїР»Р°С‚Р° Р·Р° РїРѕР·РёС†РёРё + РІС‹РїР»Р°С‚С‹ РїРѕРјРѕС‰РЅРёРєР°Рј; РѕРєР»Р°Рґ РјР°СЃС‚РµСЂР° Рё
          СЃС‚Р°РІРєР° СЃРІС‹С€Рµ 30 РєР°Р»СЊСЏРЅРѕРІ вЂ” РІ СЂР°Р·РґРµР»Рµ В«РЎРѕС‚СЂСѓРґРЅРёРєРё Рё Р·Р°СЂРїР»Р°С‚С‹В».
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 10 }}>
          {menuDirty && <span className="saving">Р•СЃС‚СЊ РЅРµСЃРѕС…СЂР°РЅС‘РЅРЅС‹Рµ РёР·РјРµРЅРµРЅРёСЏ</span>}
          <button
            className="btn btn-primary"
            onClick={saveMenu}
            disabled={saving || !menuDirty || menuIssues.length > 0}
            data-testid="button-save-menu-tariffs"
          >
            <Check size={14} /> {saving ? "РЎРѕС…СЂР°РЅСЏРµРјвЂ¦" : "РЎРѕС…СЂР°РЅРёС‚СЊ РјРµРЅСЋ"}
          </button>
        </div>
      </div>
    </div>
</div>
  );
}

function RootApp() { return <QueryClientProvider client={qc}><AppInner /></QueryClientProvider>; }
export default RootApp;

