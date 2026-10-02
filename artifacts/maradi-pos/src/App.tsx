import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  useGetPosSession, useLoginPos, useLogoutPos, useGetPosState, useSavePosState,
  getGetPosStateQueryKey,
} from '@workspace/api-client-react';
import type { PosState, Shift, ShiftLine, InventoryItem, MenuItem } from '@workspace/api-client-react';
import {
  ArrowDownToLine, BarChart3, Boxes, Check, ChevronRight, CircleHelp, Clock3,
  Coffee, DoorOpen, Flame, LockKeyhole, Plus, Settings2, ShieldCheck, Trash2,
  TrendingUp, Users, X, Pencil, RotateCcw,
} from 'lucide-react';
import NotFound from '@/pages/not-found';

const qc = new QueryClient();
const STAFF = ['Амид', 'Амид + Олег', 'Амид + Ренат', 'Олег', 'Ренат', 'Максим'];
const PRICE_CHOICES = [1500, 2000, 2500, 3600];
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
function consumeInventory(inventory: InventoryItem[], category: 'coal'|'tobacco', amount: number): InventoryItem[] | null {
  let remaining = amount;
  const next = inventory.map(item => {
    if (categoryKind(item.category) !== category || remaining <= 0) return item;
    const used = Math.min(item.stock, remaining);
    remaining -= used;
    return { ...item, stock: item.stock - used };
  });
  return remaining > 0.0001 ? null : next;
}
function shiftUsage(shift:Shift) {
  return {
    coal: shift.lines.length*0.072+shift.refills*0.036,
    tobacco: shift.lines.reduce((n,line)=>n+line.tobaccoGrams,0)+shift.refills*24,
  };
}
function adjustInventory(inventory:InventoryItem[],category:'coal'|'tobacco',amount:number):InventoryItem[]|null {
  if(amount<0)return consumeInventory(inventory,category,-amount);
  if(amount===0)return inventory;
  const first=inventory.find(i=>categoryKind(i.category)===category);
  if(!first)return null;
  return inventory.map(i=>i.id===first.id?{...i,stock:i.stock+amount}:i);
}
function adjustForShiftChange(inventory:InventoryItem[],previous:Shift,next:Shift|null):InventoryItem[]|null {
  const oldUse=shiftUsage(previous);
  const newUse=next?shiftUsage(next):{coal:0,tobacco:0};
  const coal=adjustInventory(inventory,'coal',oldUse.coal-newUse.coal);
  return coal?adjustInventory(coal,'tobacco',oldUse.tobacco-newUse.tobacco):null;
}
const DEFAULT_STATE: PosState = {
  menu: [
    { id: 'classic', name: 'Классика', price: 1500, tobaccoGrams: 24, enabled: true },
    { id: 'mix', name: 'Микс вкусов', price: 2000, tobaccoGrams: 27, enabled: true },
    { id: 'signature', name: 'Авторский', price: 2500, tobaccoGrams: 27, enabled: true },
    { id: 'premium', name: 'Премиум', price: 3600, tobaccoGrams: 27, enabled: true },
  ],
  permissions: { menuItemIds: ['classic', 'mix', 'signature', 'premium'], seeRevenue: false, useDiscounts: false, addInventory: false, editPastInventory: false, editPastShifts: false },
  inventory: [], containers: [], shifts: [], coalOpeningKg: 0, updatedAt: new Date().toISOString(),
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
  const [, setLocation] = useLocation();
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
  const currentPath = window.location.pathname;
  const needsLogin = !loggedIn;
  const isStateLoading = loggedIn && stateQuery.isLoading;

  useEffect(() => {
    if (loggedIn && currentPath === '/') setLocation('/shift');
    if (needsLogin && currentPath !== '/') setLocation('/');
  }, [loggedIn, needsLogin, currentPath, setLocation]);

  if (sessionQuery.isLoading) return <LoadingScreen />;
  if (sessionQuery.isError) return <QueryError title="Не удалось проверить вход" retry={() => sessionQuery.refetch()} />;
  if (!loggedIn) return <LoginScreen pending={login.isPending} error={login.error} onLogin={(pin) => login.mutate({ data: { pin } }, { onSuccess: (s) => { queryClient.setQueryData(['/api/pos/session'], s); sessionQuery.refetch(); } })} />;
  if (stateQuery.isError) return <Shell role={role} logout={() => logout.mutate(undefined)}><QueryError title="Не удалось загрузить данные смены" retry={() => stateQuery.refetch()} /></Shell>;
  if (isStateLoading || !state) return <Shell role={role} logout={() => logout.mutate(undefined, { onSuccess: () => { setState(null); queryClient.setQueryData(['/api/pos/session'], { authenticated: false, role: null }); sessionQuery.refetch(); setLocation('/'); } })}><LoadingScreen inline /></Shell>;
  if (!state) return <LoadingScreen />;

  const saveState = (next: PosState) => persist(next);
  const shared = { state, saveState, role, canRevenue, isAdmin, saving: save.isPending };
  const onLogout = () => logout.mutate(undefined, { onSuccess: () => { setState(null); queryClient.setQueryData(['/api/pos/session'], { authenticated: false, role: null }); sessionQuery.refetch(); setLocation('/'); } });
  return <Shell role={role} logout={onLogout} saving={save.isPending} saveFailed={save.isError}>
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

function Shell({ children, role, logout, saving = false, saveFailed = false }: { children: ReactNode; role: string; logout: () => void; saving?: boolean; saveFailed?: boolean }) {
  const [path] = useLocation();
  const nav = [{ href: '/shift', label: 'Смена', icon: Coffee }, { href: '/inventory', label: 'Склад', icon: Boxes }, { href: '/reports', label: 'Отчёты', icon: BarChart3 }, { href: '/settings', label: 'Настройки', icon: Settings2 }];
  return <div className="app-shell">
    <header className="topbar"><Link href="/shift" className="brand"><span className="brand-mark">М</span> МАРАДИ <span style={{ color: '#777970', font: '10px Manrope', letterSpacing: '.2em' }}>POS</span></Link>
      <nav className="nav">{nav.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}>{n.label}</Link>)}</nav>
      <div className="top-right">{saving && <span className="saving">Сохраняем…</span>}{saveFailed && <span role="alert" className="saving" style={{color:'#df897d'}}>Не сохранено · обновите данные и повторите</span>}<span className="role-pill">{role === 'admin' ? 'Администратор' : 'Сотрудник'}</span><div className="user-chip"><span className="avatar">{role === 'admin' ? 'A' : 'С'}</span><span>Терминал</span></div><button title="Выйти" className="btn btn-quiet btn-sm" onClick={logout} data-testid="button-logout"><DoorOpen size={16} /></button></div>
    </header>
    <main>{children}</main>
    <nav className="mobile-nav">{nav.map(n => { const Icon = n.icon; return <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><Icon size={18} /><span>{n.label}</span></Link>; })}</nav>
  </div>;
}

type Shared = { state: PosState; saveState: (state: PosState, onSuccess?: () => void) => void; role: string; canRevenue: boolean; isAdmin: boolean; saving: boolean };

function ShiftPage({ state, saveState, role, canRevenue, isAdmin, saving }: Shared) {
  const [master, setMaster] = useState(STAFF[0]);
  const [lines, setLines] = useState<ShiftLine[]>([]);
  const [refills, setRefills] = useState(0);
  const [helpersPay, setHelpersPay] = useState(0);
  const [comment, setComment] = useState('');
  const [fixedSalary, setFixedSalary] = useState<number | ''>('');
  const [date, setDate] = useState(localDate());
  const [discountOpen, setDiscountOpen] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const allowedMenu = state.menu.filter(item => item.enabled && (isAdmin || state.permissions.menuItemIds.includes(item.id)));
  const total = lines.reduce((sum, line) => sum + saleAmount(line.unitPrice, line.discount), 0);
  const payroll = calcPayroll(master, lines.length, fixedSalary === '' ? null : Number(fixedSalary), helpersPay);
  const addLine = (menu: MenuItem) => { if(!saving)setLines(prev => [...prev, { id: uid(), menuItemId: menu.id, menuItemName: menu.name, unitPrice: menu.price, tobaccoGrams: menu.tobaccoGrams, discount: 0, reason: '' }]); };
  const changeLine = (id: string, patch: Partial<ShiftLine>) => { if(!saving)setLines(prev => prev.map(line => line.id === id ? { ...line, ...patch } : line)); };
  const saveShift = () => {
    if(saving)return;
    if (!lines.length) return;
    if (lines.some(line=>line.discount>0&&!line.reason.trim())) { window.alert('Укажите причину для каждой скидки.'); return; }
    const shift: Shift = { id: uid(), date, master, lines, refills, helpersPay: Number(helpersPay) || 0, comment, fixedSalary: fixedSalary === '' ? null : Number(fixedSalary), createdAt: new Date().toISOString() };
    const coalUse = lines.length * 0.072 + refills * 0.036;
    const tobaccoUse = lines.reduce((n, line) => n + line.tobaccoGrams, 0) + refills * 24;
    const withCoal = consumeInventory(state.inventory, 'coal', coalUse);
    const withTobacco = withCoal && consumeInventory(withCoal, 'tobacco', tobaccoUse);
    if (!withCoal || !withTobacco) { window.alert('Недостаточно угля или табака на складе. Сначала внесите поставку или скорректируйте остаток.'); return; }
    saveState({ ...state, inventory: withTobacco, shifts: [shift, ...state.shifts] }, () => {
      setLines([]); setRefills(0); setHelpersPay(0); setComment(''); setFixedSalary(''); setSavedMsg('Смена записана в журнал');
      window.setTimeout(() => setSavedMsg(''), 3500);
    });
  };
  const visibleRevenue = canRevenue;
  const kgUsed = (lines.length * 72 + refills * 36) / 1000;
  const tobacco = lines.reduce((n, line) => n + line.tobaccoGrams, 0) + refills * 24;
  return <div className="page fade-in">
    <div className="page-head"><div><div className="eyebrow">Операционный журнал / сегодня</div><h1>Ввод смены</h1><div className="subhead">Зафиксируйте каждую чашу и расходы команды до закрытия.</div></div><div className="tag green"><span style={{ width: 7, height: 7, background: '#8bb49c', borderRadius: 9, marginRight: 7 }} />Смена открыта</div></div>
    {savedMsg && <div className="notice" style={{ marginBottom: 16 }}>{savedMsg}</div>}
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.55fr) minmax(300px,.85fr)', alignItems: 'start' }}>
      <section className="grid">
        <div className="card"><div className="section-title"><span>01 / Кто на смене</span><Users size={16} color="#b69a59" /></div>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}><div><label className="label">Мастер</label><select className="select" value={master} onChange={e => setMaster(e.target.value)} data-testid="select-master">{STAFF.map(s => <option key={s}>{s}</option>)}</select></div><div><label className="label">Дата смены</label><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-shift-date" /></div></div>
          <div className="divider" /><div className="section-title"><span>Добавить кальян</span><span className="tag">{lines.length} в смене</span></div>
          {allowedMenu.length ? <div className="menu-grid">{allowedMenu.map(item => <button key={item.id} className="menu-tile" onClick={() => addLine(item)} data-testid={`button-add-${item.id}`}><span>{item.name}</span><span className="grams">{item.tobaccoGrams} г</span><div className="price">{rub(item.price)}</div></button>)}</div> : <div className="empty">Для вашей учётной записи пока не открыты позиции меню.</div>}
        </div>
        <div className="card"><div className="section-title"><span>02 / Позиции смены</span><span className="tag gold">{lines.length} кальянов</span></div>
          {!lines.length ? <div className="empty">Выберите позицию меню — она появится здесь.</div> : lines.map((line, idx) => {
            return <div className="line-row" key={line.id} data-testid={`row-shift-line-${line.id}`}><div><b style={{ fontSize: 12 }}>{idx + 1}. {line.menuItemName}</b><div className="subhead" style={{ marginTop: 3 }}>{line.tobaccoGrams} г табака</div></div>
              {state.permissions.useDiscounts || isAdmin ? <select className="select" aria-label="Скидка" value={line.discount} onChange={e => { const value = Number(e.target.value) as 0 | 50 | 100; changeLine(line.id, { discount: value, reason: value ? line.reason : '' }); setDiscountOpen(value ? line.id : null); }} data-testid={`select-discount-${line.id}`}>{DISCOUNTS.map(d => <option key={d} value={d}>{d ? (d === 100 ? '100% · бесплатно' : '50%') : 'Без скидки'}</option>)}</select> : <span className="tag">Без скидки</span>}
              <span className="mono" style={{ textAlign: 'right', fontSize: 12 }}>{rub(saleAmount(line.unitPrice, line.discount))}</span><button className="btn btn-quiet btn-sm" aria-label="Удалить кальян" onClick={() => setLines(prev => prev.filter(l => l.id !== line.id))} data-testid={`button-remove-line-${line.id}`}><X size={16} /></button>
              {discountOpen === line.id && <div style={{ gridColumn: '1 / -1', padding: '4px 0 8px' }}><label className="label">Причина скидки</label><input className="input" placeholder="Например: постоянный гость" value={line.reason} onChange={e => changeLine(line.id, { reason: e.target.value })} data-testid={`input-discount-reason-${line.id}`} /></div>}
            </div>;
          })}
          <div className="divider" /><div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 11 }}>
            <div><label className="label">Доливки</label><input className="input" type="number" min="0" value={refills} onChange={e => setRefills(Math.max(0, Number(e.target.value)))} data-testid="input-refills" /></div>
            <div><label className="label">Помощникам, ₽</label><input className="input" type="number" min="0" value={helpersPay} onChange={e => setHelpersPay(Math.max(0, Number(e.target.value)))} data-testid="input-helpers-pay" /></div>
            {master === 'Амид' && <div><label className="label">Фикс. оклад, ₽</label><input className="input" type="number" min="0" placeholder="По умолчанию" value={fixedSalary} onChange={e => setFixedSalary(e.target.value === '' ? '' : Number(e.target.value))} data-testid="input-fixed-salary" /></div>}
          </div>
          <div style={{ marginTop: 12 }}><label className="label">Комментарий к смене</label><textarea className="textarea" value={comment} onChange={e => setComment(e.target.value)} placeholder="Особые обстоятельства, списания…" data-testid="input-shift-comment" /></div>
        </div>
      </section>
      <aside className="grid">
        <div className="card" style={{ borderColor: '#54472d', background: 'linear-gradient(150deg,#242117,#191a1d)' }}>
          <div className="section-title"><span>Сводка смены</span><Clock3 size={16} color="#d4aa4c" /></div>
          {visibleRevenue ? <><div className="kpi-label">ВЫРУЧКА ПО ПОЗИЦИЯМ</div><div className="kpi-value">{rub(total)}</div><div className="divider" /></> : <div className="notice" style={{ marginBottom: 17 }}>Выручка скрыта настройками доступа.</div>}
          <div style={{ display: 'grid', gap: 12 }}><SummaryRow label="Кальяны" value={`${lines.length} шт.`} /><SummaryRow label="Уголь списан" value={`${kgUsed.toFixed(3)} кг`} /><SummaryRow label="Табак учтён" value={`${tobacco} г`} />
            {canRevenue && <><SummaryRow label="Расчёт мастера" value={rub(payroll)} highlight /><SummaryRow label="Помощники" value={rub(helpersPay)} /></>}</div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 23, minHeight: 46 }} disabled={!lines.length||saving} onClick={saveShift} data-testid="button-save-shift"><Check size={16} /> {saving?'Сохраняем…':'Записать смену'}</button>
          <p style={{ color: '#777b81', fontSize: 10, lineHeight: 1.5, textAlign: 'center', margin: '12px 0 0' }}>Запись сохранится в общей истории и отчётах.</p>
        </div>
        <div className="card"><div className="section-title"><span>Правила расчёта</span><CircleHelp size={16} color="#858990" /></div><div style={{ display: 'grid', gap: 10, color: '#999da3', fontSize: 11, lineHeight: 1.5 }}><div>Уголь: <span className="mono">72 г</span> на кальян + <span className="mono">36 г</span> на доливку</div><div>Табак: <span className="mono">24–27 г</span> на чашу, <span className="mono">24 г</span> на доливку</div><div>Мастер: базовая оплата + <span className="mono">100 ₽</span> за кальян</div></div></div>
      </aside>
    </div>
  </div>;
}
function SummaryRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) { return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}><span style={{ color: '#92959b' }}>{label}</span><b className="mono" style={{ color: highlight ? '#e5c466' : '#e2ded4', fontSize: 12 }}>{value}</b></div>; }
function calcPayroll(master: string, count: number, fixed: number | null, helpers = 0) {
  void helpers;
  if (master === 'Амид') return (fixed ?? (count > 30 ? 5000 : 3300)) + count * 100;
  if (master === 'Амид + Олег' || master === 'Амид + Ренат') return ((count > 30 ? 5000 : 3300) + count * 100) / 2;
  if (master === 'Олег' || master === 'Ренат' || master === 'Максим') return 2800 + count * 100;
  return 0;
}

function InventoryPage({ state, saveState, isAdmin, saving }: Shared) {
  const [tab, setTab] = useState<'stock'|'deliveries'|'tare'>('stock');
  const [name, setName] = useState(''); const [category, setCategory] = useState('tobacco'); const [brand, setBrand] = useState('');
  const [packageGrams, setPackageGrams] = useState(100); const [stock, setStock] = useState(0); const [unit, setUnit] = useState('г');
  const [deliveryItem, setDeliveryItem] = useState(''); const [deliveryQty, setDeliveryQty] = useState(1);
  const [containerName, setContainerName] = useState(''); const [tare, setTare] = useState(0); const [coal, setCoal] = useState(state.coalOpeningKg);
  const [weighItem, setWeighItem] = useState(state.inventory.find(i=>categoryKind(i.category)==='tobacco')?.id??'');
  const [weighContainer, setWeighContainer] = useState(state.containers[0]?.id??'');
  const [grossGrams, setGrossGrams] = useState(0);
  const mayAdd = isAdmin || state.permissions.addInventory;
  const mayCorrect = isAdmin || state.permissions.editPastInventory;
  const coalCurrent = state.inventory.filter(i=>categoryKind(i.category)==='coal').reduce((n,i)=>n+i.stock,0);
  const coalUsed = state.shifts.reduce((n,s)=>n+s.lines.length*0.072+s.refills*0.036,0);
  const coalDeliveries = Math.max(0,coalCurrent+coalUsed-state.coalOpeningKg);
  const createItem = () => { if (saving || !isAdmin || !name.trim()) return; const normalizedUnit=category==='coal'?'кг':category==='tobacco'?'г':unit; const item: InventoryItem = { id: uid(), name: name.trim(), category, brand: brand.trim(), packageGrams: Number(packageGrams), stock: Number(stock), unit:normalizedUnit }; saveState({ ...state, inventory: [...state.inventory, item] },()=>{setName('');setBrand('');setStock(0);}); };
  const recordDelivery = () => { const item = state.inventory.find(i => i.id === deliveryItem); if (saving || !item || deliveryQty <= 0) return; saveState({ ...state, inventory: state.inventory.map(i => i.id === deliveryItem ? { ...i, stock: i.stock + Number(deliveryQty) } : i) },()=>setDeliveryQty(1)); };
  const createContainer = () => { if (saving || !isAdmin || !containerName.trim()) return; saveState({ ...state, containers: [...state.containers, { id: uid(), name: containerName.trim(), tareGrams: Number(tare) }] },()=>{setContainerName('');setTare(0);}); };
  const deleteItem = (id: string) => { if (!saving && isAdmin && window.confirm('Удалить позицию склада?')) saveState({ ...state, inventory: state.inventory.filter(i => i.id !== id) }); };
  const correctStock = (item:InventoryItem) => {
    if(saving||!mayCorrect) return;
    const answer=window.prompt(`Введите фактический остаток (${item.unit})`,String(item.stock));
    if(answer===null)return;
    const value=Number(answer);
    if(!Number.isFinite(value)||value<0){window.alert('Остаток должен быть числом не меньше нуля.');return;}
    saveState({...state,inventory:state.inventory.map(i=>i.id===item.id?{...i,stock:value}:i)});
  };
  const recordWeighing = () => {
    const item=state.inventory.find(i=>i.id===weighItem);
    const container=state.containers.find(c=>c.id===weighContainer);
    if(saving||!mayCorrect||!item||!container||grossGrams<container.tareGrams)return;
    const net=Math.max(0,grossGrams-container.tareGrams);
    saveState({...state,inventory:state.inventory.map(i=>i.id===item.id?{...i,stock:net,unit:'г'}:i)});
  };
  return <div className="page fade-in">
    <div className="page-head"><div><div className="eyebrow">Контроль остатков / склад</div><h1>Запасы и поставки</h1><div className="subhead">Остатки расходников, приёмка поставок и тара.</div></div><div className="tag gold"><Boxes size={13} style={{ marginRight: 6 }} />{state.inventory.length} позиций</div></div>
    <div className="grid kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 17 }}>
      <div className="card kpi"><div className="kpi-label">ПОЗИЦИЙ НА СКЛАДЕ</div><div className="kpi-value">{state.inventory.length}</div><div className="kpi-note">учитываются в остатках</div></div>
      <div className="card kpi"><div className="kpi-label">ТЕКУЩИЙ ОСТАТОК УГЛЯ</div><div className="kpi-value">{coalCurrent.toFixed(2)} кг</div><div className="kpi-note">начало {state.coalOpeningKg.toFixed(2)} · приход {coalDeliveries.toFixed(2)} кг</div></div>
      <div className="card kpi"><div className="kpi-label">СПИСАНИЕ ЗА СМЕНЫ</div><div className="kpi-value">{coalUsed.toFixed(2)} кг</div><div className="kpi-note">72 г на кальян · 36 г на доливку</div></div>
    </div>
    <div className="card">
      <div style={{ display: 'flex', gap: 7, borderBottom: '1px solid #303239', margin: '-2px 0 20px', overflowX: 'auto' }}>{([['stock','Остатки'],['deliveries','Приёмка'],['tare','Тара']] as const).map(([id,label])=><button key={id} className={`btn btn-sm ${tab===id?'btn-primary':''}`} style={{ borderRadius:'9px 9px 0 0', borderBottom: tab===id?'2px solid #d4aa4c':'' }} onClick={()=>setTab(id)} data-testid={`tab-${id}`}>{label}</button>)}</div>
      {tab === 'stock' && <><div className="section-title"><span>Текущий остаток</span>{isAdmin && <button className="btn btn-primary btn-sm" onClick={()=>document.getElementById('new-stock-item')?.scrollIntoView({behavior:'smooth'})} data-testid="button-new-stock"><Plus size={14}/> Новая позиция</button>}</div>
        {!state.inventory.length ? <div className="empty">Склад пока пуст. Добавьте первую позицию или внесите поставку.</div> : <div className="table-wrap"><table><thead><tr><th>Позиция</th><th>Категория</th><th>Бренд</th><th>Фасовка</th><th>Остаток</th><th></th></tr></thead><tbody>{state.inventory.map(item=><tr key={item.id} data-testid={`row-inventory-${item.id}`}><td><b>{item.name}</b></td><td>{categoryKind(item.category)==='coal'?'Уголь':categoryKind(item.category)==='tobacco'?'Табак':item.category}</td><td>{item.brand || '—'}</td><td className="mono">{item.packageGrams} г</td><td><span className={`tag ${item.stock <= 2?'gold':'green'}`}>{item.stock} {item.unit}</span></td><td style={{whiteSpace:'nowrap'}}>{mayCorrect&&<button className="btn btn-quiet btn-sm" onClick={()=>correctStock(item)} aria-label="Скорректировать остаток" title="Переучёт"><Pencil size={14}/></button>}{isAdmin&&<button className="btn btn-quiet btn-sm btn-danger" onClick={()=>deleteItem(item.id)} aria-label="Удалить"><Trash2 size={14}/></button>}</td></tr>)}</tbody></table></div>}
        {isAdmin && <div id="new-stock-item"><div className="divider"/><div className="section-title"><span>Новая складская позиция</span><Plus size={15} color="#d4aa4c"/></div><div className="grid" style={{gridTemplateColumns:'repeat(3,1fr)',gap:11}}><div><label className="label">Наименование</label><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Например, табак" data-testid="input-item-name"/></div><div><label className="label">Категория</label><select className="select" value={category} onChange={e=>{const value=e.target.value;setCategory(value);setUnit(value==='coal'?'кг':value==='tobacco'?'г':'шт.')}}><option value="tobacco">Табак</option><option value="coal">Уголь</option><option value="consumables">Расходники</option><option value="drinks">Напитки</option><option value="other">Прочее</option></select></div><div><label className="label">Бренд</label><input className="input" value={brand} onChange={e=>setBrand(e.target.value)} placeholder="Марка"/></div><div><label className="label">Фасовка, г</label><input className="input" type="number" min="0" value={packageGrams} onChange={e=>setPackageGrams(Number(e.target.value))}/></div><div><label className="label">Остаток</label><input className="input" type="number" min="0" value={stock} onChange={e=>setStock(Number(e.target.value))}/></div><div><label className="label">Единица</label><select className="select" value={unit} onChange={e=>setUnit(e.target.value)}><option>г</option><option>кг</option><option>уп.</option><option>шт.</option><option>кор.</option></select></div></div><button className="btn btn-primary" style={{marginTop:13}} onClick={createItem} data-testid="button-create-inventory"><Plus size={14}/> Добавить на склад</button></div>}
      </>}
      {tab === 'deliveries' && <><div className="section-title"><span>Приход товара</span><ArrowDownToLine size={16} color="#d4aa4c"/></div>{!mayAdd && <div className="notice" style={{marginBottom:14}}>Приёмку может вносить только сотрудник с соответствующим доступом.</div>}<div className="grid" style={{gridTemplateColumns:'minmax(0,1fr) 130px auto',alignItems:'end',gap:12}}><div><label className="label">Позиция склада</label><select className="select" value={deliveryItem} onChange={e=>setDeliveryItem(e.target.value)}><option value="">Выберите позицию</option>{state.inventory.map(i=><option key={i.id} value={i.id}>{i.name} · сейчас {i.stock} {i.unit}</option>)}</select></div><div><label className="label">Количество ({state.inventory.find(i=>i.id===deliveryItem)?.unit??'ед.'})</label><input className="input" type="number" min="0.001" step="any" value={deliveryQty} onChange={e=>setDeliveryQty(Number(e.target.value))}/></div><button className="btn btn-primary" disabled={!mayAdd||!deliveryItem} onClick={recordDelivery} data-testid="button-record-delivery"><Check size={15}/> Принять</button></div><div className="divider"/><div className="grid" style={{gridTemplateColumns:'1fr auto',alignItems:'end',gap:12}}><div><label className="label">Начальный остаток угля, кг</label><input className="input" type="number" min="0" step=".1" value={coal} disabled={!mayCorrect} onChange={e=>setCoal(Number(e.target.value))}/></div><button className="btn" disabled={!mayCorrect} onClick={()=>saveState({...state,coalOpeningKg:coal})} data-testid="button-save-coal"><Flame size={15}/> Сохранить остаток</button></div></>}
      {tab === 'tare' && <><div className="section-title"><span>Инвентаризация и тара</span><span className="tag">{state.containers.length} ёмк.</span></div>{state.inventory.some(i=>categoryKind(i.category)==='tobacco')&&state.containers.length>0?<><div className="grid" style={{gridTemplateColumns:'1fr 1fr 150px auto',alignItems:'end',gap:12}}><div><label className="label">Табак</label><select className="select" value={weighItem} onChange={e=>setWeighItem(e.target.value)}>{state.inventory.filter(i=>categoryKind(i.category)==='tobacco').map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></div><div><label className="label">Тара</label><select className="select" value={weighContainer} onChange={e=>setWeighContainer(e.target.value)}>{state.containers.map(c=><option key={c.id} value={c.id}>{c.name} · {c.tareGrams} г</option>)}</select></div><div><label className="label">Вес брутто, г</label><input className="input" type="number" min="0" value={grossGrams} onChange={e=>setGrossGrams(Number(e.target.value))}/></div><button className="btn btn-primary" disabled={!mayCorrect||grossGrams<(state.containers.find(c=>c.id===weighContainer)?.tareGrams??0)} onClick={recordWeighing} data-testid="button-weigh-tobacco"><Check size={15}/> Переучесть</button></div><p className="subhead">Чистый вес: {Math.max(0,grossGrams-(state.containers.find(c=>c.id===weighContainer)?.tareGrams??0))} г (брутто минус тара).</p></>:<div className="empty">Добавьте складскую позицию табака и ёмкость, чтобы выполнить взвешивание.</div>}{state.containers.length>0&&<div className="table-wrap"><table><thead><tr><th>Ёмкость</th><th>Вес тары</th><th></th></tr></thead><tbody>{state.containers.map(c=><tr key={c.id}><td>{c.name}</td><td className="mono">{c.tareGrams} г</td><td>{isAdmin&&<button className="btn btn-quiet btn-sm" aria-label="Удалить тару" onClick={()=>saveState({...state,containers:state.containers.filter(x=>x.id!==c.id)})}><Trash2 size={14}/></button>}</td></tr>)}</tbody></table></div>}{isAdmin&&<><div className="divider"/><div className="grid" style={{gridTemplateColumns:'1fr 160px auto',alignItems:'end',gap:12}}><div><label className="label">Название ёмкости</label><input className="input" value={containerName} onChange={e=>setContainerName(e.target.value)} placeholder="Например, банка 1 л"/></div><div><label className="label">Вес тары, г</label><input className="input" type="number" min="0" value={tare} onChange={e=>setTare(Number(e.target.value))}/></div><button className="btn btn-primary" onClick={createContainer} data-testid="button-add-container"><Plus size={14}/> Добавить</button></div></>}</>}
    </div>
  </div>;
}

type Period = 'day'|'week'|'month';
function ReportsPage({state, isAdmin, canRevenue, saveState}: Shared) {
  const [period,setPeriod]=useState<Period>('week');
  const [selectedDate,setSelectedDate]=useState(localDate());
  const [editing,setEditing]=useState<Shift|null>(null);
  const current = new Date(`${selectedDate}T12:00:00`);
  const start = new Date(current); if(period==='week') start.setDate(start.getDate()-6); if(period==='month') start.setDate(1);
  const end = new Date(current); if(period==='month') { end.setMonth(end.getMonth()+1); end.setDate(0); }
  const filtered = state.shifts.filter(s=>{const d=new Date(`${s.date}T12:00:00`);return d>=start&&d<=end;});
  const totalHooks=filtered.reduce((n,s)=>n+s.lines.length,0);
  const revenue=filtered.reduce((n,s)=>n+s.lines.reduce((m,l)=>m+saleAmount(l.unitPrice,l.discount),0),0);
  const payrolls = filtered.reduce((n,s)=>n+calcPayroll(s.master,s.lines.length,s.fixedSalary)+s.helpersPay,0);
  const tobaccoUsed = filtered.reduce((n,s)=>n+s.lines.reduce((m,l)=>m+l.tobaccoGrams,0)+s.refills*24,0);
  const helpersTotal = filtered.reduce((n,s)=>n+s.helpersPay,0);
  const discounts=filtered.flatMap(s=>s.lines.filter(l=>l.discount>0).map(l=>({shift:s,line:l})));
  const cats = [...new Set(filtered.flatMap(s=>s.lines.map(line=>line.menuItemName)))].map(name=>({name,count:filtered.reduce((n,s)=>n+s.lines.filter(l=>l.menuItemName===name).length,0)})).filter(x=>x.count);
  const spanText = `${ruDate(start.toISOString())} — ${ruDate(end.toISOString())}`;
  const mayEdit = isAdmin || state.permissions.editPastShifts;
  const removeShift=(id:string)=>{
    const previous=state.shifts.find(s=>s.id===id);
    if(!previous||!window.confirm('Удалить запись смены?'))return;
    const inventory=adjustForShiftChange(state.inventory,previous,null);
    if(!inventory){window.alert('Не удалось восстановить остатки по этой смене.');return;}
    saveState({...state,inventory,shifts:state.shifts.filter(s=>s.id!==id)});
  };
  const updateShift=(s:Shift)=>{
    const previous=state.shifts.find(old=>old.id===s.id);
    if(!previous)return;
    const inventory=adjustForShiftChange(state.inventory,previous,s);
    if(!inventory){window.alert('Недостаточно остатков для изменений этой смены.');return;}
    saveState({...state,inventory,shifts:state.shifts.map(x=>x.id===s.id?s:x)},()=>setEditing(null));
  };
  return <div className="page fade-in">
    <div className="page-head"><div><div className="eyebrow">Сводка / история</div><h1>Отчёты</h1><div className="subhead">Сверка выручки, загрузки и расчётов команды.</div></div><div className="tag"><TrendingUp size={13} style={{marginRight:6}}/>Период: {spanText}</div></div>
    <div style={{display:'flex',gap:7,alignItems:'center',marginBottom:17,flexWrap:'wrap'}}>{([['day','День'],['week','Неделя'],['month','Месяц']] as [Period,string][]).map(([id,label])=><button key={id} className={`btn btn-sm ${period===id?'btn-primary':''}`} onClick={()=>setPeriod(id)} data-testid={`button-period-${id}`}>{label}</button>)}<input aria-label="Дата отчёта" className="input" style={{width:165,marginLeft:'auto'}} type="date" value={selectedDate} onChange={e=>setSelectedDate(e.target.value)} data-testid="input-report-date"/></div>
    <div className="grid kpis" style={{gridTemplateColumns:'repeat(4,1fr)',marginBottom:17}}>
      {canRevenue?<div className="card kpi"><div className="kpi-label">ВЫРУЧКА</div><div className="kpi-value">{rub(revenue)}</div><div className="kpi-note">за выбранный период</div></div>:<div className="card kpi"><div className="kpi-label">ВЫРУЧКА</div><div className="kpi-value" style={{fontSize:20}}>Скрыта</div><div className="kpi-note">нет разрешения на просмотр</div></div>}
      <div className="card kpi"><div className="kpi-label">КАЛЬЯНЫ</div><div className="kpi-value">{totalHooks}</div><div className="kpi-note">всего за период</div></div>
      {canRevenue?<div className="card kpi"><div className="kpi-label">ФОТ</div><div className="kpi-value">{rub(payrolls)}</div><div className="kpi-note">доля от выручки · {revenue?`${(payrolls/revenue*100).toFixed(1)}%`:'—'}</div></div>:<div className="card kpi"><div className="kpi-label">СМЕНЫ</div><div className="kpi-value">{filtered.length}</div><div className="kpi-note">закрыто за период</div></div>}
      <div className="card kpi"><div className="kpi-label">РАСХОД ТАБАКА</div><div className="kpi-value">{tobaccoUsed} г</div><div className="kpi-note">{filtered.reduce((n,s)=>n+s.refills,0)} доливок · уголь {(filtered.reduce((n,s)=>n+s.lines.length*72+s.refills*36,0)/1000).toFixed(2)} кг</div></div>
    </div>
    <div className="grid" style={{gridTemplateColumns:'minmax(0,1.05fr) minmax(0,.95fr)',alignItems:'start'}}>
      <div className="card"><div className="section-title"><span>Категории кальянов</span><span className="tag">{cats.reduce((n,c)=>n+c.count,0)} шт.</span></div>{cats.length?<div style={{display:'grid',gap:16}}>{cats.map((cat,i)=><div key={cat.name}><div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:7}}><span>{cat.name}</span><b className="mono">{cat.count} · {totalHooks?Math.round(cat.count/totalHooks*100):0}%</b></div><div style={{height:5,background:'#303239',borderRadius:8}}><div style={{height:5,width:`${totalHooks?cat.count/totalHooks*100:0}%`,borderRadius:8,background:['#d2aa50','#5e9d89','#b2785d','#748ead'][i%4]}}/></div></div>)}</div>:<div className="empty">В периоде пока нет продаж.</div>}
         {canRevenue&&<><div className="divider"/><div className="section-title"><span>Расчёт по мастерам</span></div>{uniqueMasters(filtered).map(m=>{const rows=filtered.filter(s=>s.master===m||s.master.split(' + ').includes(m));const earned=rows.reduce((n,s)=>n+payrollForMaster(s,m),0);return <div key={m} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:'1px solid #2b2d32',fontSize:12}}><span>{m}<span style={{color:'#777b81',marginLeft:8}}>{rows.length} смен</span></span><b className="mono" style={{color:'#ddc16f'}}>{rub(earned)} <small style={{color:'#81858b'}}>· {revenue?((earned/revenue)*100).toFixed(1):'0.0'}%</small></b></div>})}<div style={{display:'flex',justifyContent:'space-between',padding:'9px 0',fontSize:12}}><span>Доп. выплаты помощникам</span><b className="mono">{rub(helpersTotal)}</b></div></>}
      </div>
       <div className="card"><div className="section-title"><span>Скидки и причины</span><span className="tag">{discounts.length} случаев</span></div>{discounts.length?<div className="table-wrap"><table><thead><tr><th>Смена</th><th>Позиция</th><th>Скидка</th><th>Причина</th></tr></thead><tbody>{discounts.map(({shift,line})=><tr key={line.id}><td>{ruDate(shift.date)}</td><td>{line.menuItemName}</td><td className="mono">{line.discount}% · −{rub(line.unitPrice*line.discount/100)}</td><td>{line.reason||'—'}</td></tr>)}</tbody></table></div>:<div className="empty">В выбранном периоде скидок нет.</div>}</div>
    </div>
     <div className="card" style={{marginTop:17}}><div className="section-title"><span>История смен</span><span className="tag">{filtered.length} записей</span></div>{filtered.length?<div className="table-wrap"><table><thead><tr><th>Дата</th><th>Мастер</th><th>Кальяны</th>{canRevenue&&<><th>Выручка</th><th>Начислено</th></>}<th>Комментарий</th><th></th></tr></thead><tbody>{filtered.map(s=>{const rev=s.lines.reduce((n,l)=>n+saleAmount(l.unitPrice,l.discount),0);const pay=calcPayroll(s.master,s.lines.length,s.fixedSalary)+s.helpersPay;return <tr key={s.id} data-testid={`row-shift-${s.id}`}><td>{ruDate(s.date)}</td><td>{s.master}</td><td className="mono">{s.lines.length}</td>{canRevenue&&<><td className="mono">{rub(rev)}</td><td className="mono">{rub(pay)}</td></>}<td>{s.comment||'—'}</td><td>{mayEdit&&<div style={{display:'flex',gap:4}}><button className="btn btn-quiet btn-sm" title="Изменить запись" onClick={()=>setEditing(s)} data-testid={`button-edit-shift-${s.id}`}><Pencil size={14}/></button><button className="btn btn-quiet btn-sm btn-danger" title="Удалить запись" onClick={()=>removeShift(s.id)} data-testid={`button-delete-shift-${s.id}`}><Trash2 size={14}/></button></div>}</td></tr>})}</tbody></table></div>:<div className="empty">Нет смен за выбранный период. Новые записи появятся после сохранения смены.</div>}</div>
    {editing&&<EditShift shift={editing} onClose={()=>setEditing(null)} onSave={updateShift}/>}
  </div>;
}
function uniqueMasters(shifts:Shift[]) { return [...new Set(shifts.flatMap(s=>s.master.split(' + ')))]; }
function payrollForMaster(shift:Shift, master:string) {
  if(shift.master.includes(' + ')) {
    const base=shift.master.includes('Амид')?(shift.lines.length>30?5000:3300):2800;
    return (base+shift.lines.length*100)/2;
  }
  return calcPayroll(shift.master,shift.lines.length,shift.fixedSalary);
}
function EditShift({shift,onClose,onSave}:{shift:Shift;onClose:()=>void;onSave:(s:Shift)=>void}) {
  const [date,setDate]=useState(shift.date);const [master,setMaster]=useState(shift.master);const [comment,setComment]=useState(shift.comment);const [fixed,setFixed]=useState(shift.fixedSalary??'');
  return <div style={{position:'fixed',inset:0,zIndex:50,background:'#090a0bc9',display:'grid',placeItems:'center',padding:16}}><div className="card" style={{width:'min(100%,480px)'}}><div className="section-title"><span>Изменить смену</span><button className="btn btn-quiet btn-sm" onClick={onClose}><X size={16}/></button></div><label className="label">Дата</label><input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)}/><label className="label" style={{marginTop:12}}>Мастер</label><select className="select" value={master} onChange={e=>setMaster(e.target.value)}>{STAFF.map(s=><option key={s}>{s}</option>)}</select><label className="label" style={{marginTop:12}}>Фиксированный оклад, ₽</label><input className="input" type="number" value={fixed} onChange={e=>setFixed(e.target.value===''?'':Number(e.target.value))}/><label className="label" style={{marginTop:12}}>Комментарий</label><textarea className="textarea" value={comment} onChange={e=>setComment(e.target.value)}/><div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:16}}><button className="btn" onClick={onClose}>Отмена</button><button className="btn btn-primary" onClick={()=>onSave({...shift,date,master,comment,fixedSalary:fixed===''?null:Number(fixed)})}><Check size={14}/> Сохранить</button></div></div></div>;
}

function SettingsPage({state,saveState,isAdmin,saving}:Shared) {
  const [newName,setNewName]=useState(''); const [newPrice,setNewPrice]=useState(2000);const [newGrams,setNewGrams]=useState(27);
  const [menuDraft,setMenuDraft]=useState(state.menu);
  useEffect(()=>setMenuDraft(state.menu),[JSON.stringify(state.menu)]);
  if(!isAdmin)return <div className="page"><div className="page-head"><div><div className="eyebrow">Управление доступом</div><h1>Настройки</h1></div></div><div className="card" style={{maxWidth:560}}><div className="notice">Раздел доступен администратору. Для настройки меню и прав обратитесь к управляющему.</div></div></div>;
  const setPermission=(key:keyof typeof state.permissions,value:boolean)=>saveState({...state,permissions:{...state.permissions,[key]:value}});
  const setMenuAccess=(id:string,checked:boolean)=>saveState({...state,permissions:{...state.permissions,menuItemIds:checked?[...state.permissions.menuItemIds,id]:state.permissions.menuItemIds.filter(x=>x!==id)}});
  const updateItem=(id:string,patch:Partial<MenuItem>)=>setMenuDraft(menuDraft.map(m=>m.id===id?{...m,...patch}:m));
  const addItem=()=>{if(!newName.trim())return;setMenuDraft([...menuDraft,{id:uid(),name:newName.trim(),price:Number(newPrice),tobaccoGrams:Number(newGrams),enabled:true}]);setNewName('');};
  const removeItem=(id:string)=>{if(window.confirm('Удалить позицию меню? Существующие смены останутся в истории.'))setMenuDraft(menuDraft.filter(m=>m.id!==id));};
  const menuDirty=JSON.stringify(menuDraft)!==JSON.stringify(state.menu);
  const saveMenu=()=>saveState({...state,menu:menuDraft,permissions:{...state.permissions,menuItemIds:state.permissions.menuItemIds.filter(id=>menuDraft.some(item=>item.id===id))}});
  const toggles:[keyof typeof state.permissions,string,string][]=[
    ['seeRevenue','Просмотр выручки','Разрешить сотрудникам видеть суммы продаж и зарплаты.'],
    ['useDiscounts','Скидки при вводе смены','Сотрудники могут применить скидку 50% или 100% и указать причину.'],
    ['addInventory','Приёмка товара','Разрешить вносить поставки. Каталог складских позиций меняет администратор.'],
    ['editPastInventory','Переучёт склада','Разрешить исправление фактических остатков и начального баланса угля.'],
    ['editPastShifts','Правка истории смен','Разрешить менять и удалять записи прошедших смен.'],
  ];
  return <div className="page fade-in">
    <div className="page-head"><div><div className="eyebrow">Администратор / конфигурация</div><h1>Настройки терминала</h1><div className="subhead">Меню продаж и доступ сотрудника к функциям.</div></div><div className="tag gold"><ShieldCheck size={14} style={{marginRight:6}}/>Полный доступ</div></div>
    <div className="grid" style={{gridTemplateColumns:'minmax(0,1.2fr) minmax(310px,.8fr)',alignItems:'start'}}>
      <div className="card"><div className="section-title"><span>Меню кальянов</span><span className="tag">{state.menu.length} позиций</span></div>
        {menuDraft.map(item=><div key={item.id} style={{display:'grid',gridTemplateColumns:'1fr 105px 85px 76px 30px',gap:9,alignItems:'center',padding:'11px 0',borderBottom:'1px solid #2c2e33'}}><input className="input" value={item.name} onChange={e=>updateItem(item.id,{name:e.target.value})} aria-label="Название позиции" data-testid={`input-menu-name-${item.id}`} disabled={saving}/><select className="select" value={item.price} onChange={e=>updateItem(item.id,{price:Number(e.target.value)})} aria-label="Цена" disabled={saving}>{[...new Set([...PRICE_CHOICES,item.price])].sort((a,b)=>a-b).map(p=><option key={p} value={p}>{p} ₽</option>)}</select><div style={{display:'flex',alignItems:'center',gap:5}}><input className="input" type="number" min="1" max="100" value={item.tobaccoGrams} onChange={e=>updateItem(item.id,{tobaccoGrams:Number(e.target.value)})} aria-label="Табак, грамм" disabled={saving}/><small style={{color:'#777'}}>г</small></div><button className={`btn btn-sm ${item.enabled?'':'btn-quiet'}`} onClick={()=>updateItem(item.id,{enabled:!item.enabled})} data-testid={`button-toggle-menu-${item.id}`} disabled={saving}>{item.enabled?'В меню':'Скрыта'}</button><button className="btn btn-quiet btn-sm btn-danger" onClick={()=>removeItem(item.id)} aria-label="Удалить позицию" disabled={saving}><Trash2 size={14}/></button></div>)}
        <div className="divider"/><div className="section-title"><span>Добавить позицию</span><Plus size={15} color="#d4aa4c"/></div><div className="grid" style={{gridTemplateColumns:'1fr 115px 92px auto',gap:9,alignItems:'end'}}><div><label className="label">Название</label><input className="input" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Новинка" disabled={saving}/></div><div><label className="label">Цена</label><select className="select" value={newPrice} onChange={e=>setNewPrice(Number(e.target.value))} disabled={saving}>{PRICE_CHOICES.map(p=><option key={p}>{p}</option>)}</select></div><div><label className="label">Табак, г</label><input className="input" type="number" min="1" max="100" value={newGrams} onChange={e=>setNewGrams(Number(e.target.value))} disabled={saving}/></div><button className="btn btn-primary" onClick={addItem} data-testid="button-add-menu" disabled={saving}><Plus size={14}/></button></div><div style={{display:'flex',justifyContent:'flex-end',marginTop:12}}><button className="btn btn-primary" onClick={saveMenu} disabled={saving||!menuDirty} data-testid="button-save-menu"><Check size={14}/> {saving?'Сохраняем…':'Сохранить меню'}</button></div>
      </div>
      <div className="grid">
        <div className="card"><div className="section-title"><span>Права сотрудника</span><Users size={16} color="#b99b58"/></div><div className="notice" style={{marginBottom:14}}>Настройки применяются к роли «Сотрудник» сразу после сохранения.</div>{toggles.map(([key,title,desc])=><label key={key} style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:14,padding:'12px 0',borderBottom:'1px solid #2b2d32',cursor:'pointer'}}><span><b style={{fontSize:12}}>{title}</b><span style={{display:'block',fontSize:10,color:'#81858b',marginTop:4,lineHeight:1.4}}>{desc}</span></span><input type="checkbox" checked={Boolean(state.permissions[key])} onChange={e=>setPermission(key,e.target.checked)} data-testid={`toggle-permission-${key}`} style={{accentColor:'#d4aa4c',width:18,height:18,flexShrink:0}} disabled={saving}/></label>)}</div>
        <div className="card"><div className="section-title"><span>Доступные позиции</span><ChevronRight size={16} color="#858990"/></div><p className="subhead" style={{marginTop:-8,marginBottom:14}}>Что сотрудник увидит в интерфейсе ввода смены.</p>{state.menu.map(item=><label key={item.id} style={{display:'flex',justifyContent:'space-between',padding:'9px 0',borderBottom:'1px solid #2b2d32',fontSize:12,alignItems:'center'}}><span>{item.name}<small style={{color:'#777b81',marginLeft:7}}>{rub(item.price)}</small></span><input type="checkbox" checked={state.permissions.menuItemIds.includes(item.id)} onChange={e=>setMenuAccess(item.id,e.target.checked)} data-testid={`toggle-menu-access-${item.id}`} style={{accentColor:'#d4aa4c',width:17,height:17}} disabled={saving}/></label>)}</div>
      </div>
    </div>
    <div className="card" style={{marginTop:17}}><div className="section-title"><span>Тарифы и расчёт</span><Flame size={16} color="#b99b58"/></div><div className="grid" style={{gridTemplateColumns:'repeat(4,1fr)',gap:10}}>{PRICE_CHOICES.map((p,i)=><div key={p} className="notice" style={{textAlign:'center'}}><div className="mono" style={{fontSize:17,color:'#e4c366'}}>{rub(p)}</div><div style={{fontSize:10,marginTop:4,color:'#938c78'}}>{['Базовый','Стандарт','Авторский','Премиум'][i]}</div></div>)}</div><p className="subhead" style={{fontSize:11,lineHeight:1.6}}>Расчёт мастера: Амид — 3 300 ₽ до 30 кальянов или 5 000 ₽ свыше 30, плюс 100 ₽ за кальян (фиксированный оклад можно задать при вводе). В смене с Олегом или Ренатом эта сумма делится пополам. Олег, Ренат и Максим получают 2 800 ₽ плюс 100 ₽ за кальян. Выплаты помощникам учитываются отдельно.</p></div>
  </div>;
}

function RootApp() { return <QueryClientProvider client={qc}><AppInner /></QueryClientProvider>; }
export default RootApp;