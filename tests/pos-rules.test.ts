import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calcCoalUsageKg,
  calcMasterPayrollShare,
  calcMasterShiftPayout,
  calcPayrollByMenu,
  calcTobaccoUsageGrams,
  COAL_KG_PER_HOOKAH,
  COAL_KG_PER_REBUILD,
  DEFAULT_EMPLOYEE_SALARIES,
  DEFAULT_MENU_SALARY_BONUSES,
  getShiftOwnerExtra,
  resolveReportRange,
  TOBACCO_GRAMS_PER_REBUILD,
  validateMenuItems,
  formatMenuIssue,
  parseNumericInput,
  MIN_TOBACCO_GRAMS,
  MAX_TOBACCO_GRAMS,
} from '../artifacts/maradi-pos/src/lib/pos-rules.ts';

test('payroll sums the configured bonus for each menu item', () => {
  const menu = [
    { id: 'classic', salaryBonus: 100 },
    { id: 'grapefruit', salaryBonus: 150 },
    { id: 'pineapple', salaryBonus: 150 },
    { id: 'signature', salaryBonus: 500 },
  ];

  const payroll = calcPayrollByMenu('Амид', [
    { menuItemId: 'classic' },
    { menuItemId: 'grapefruit' },
    { menuItemId: 'signature' },
  ], null, 0, menu);

  assert.equal(payroll, 3300 + 100 + 150 + 500);
});

test('default menu salary bonuses match the POS policy', () => {
  assert.deepEqual(DEFAULT_MENU_SALARY_BONUSES, {
    classic: 100,
    grapefruit: 150,
    pineapple: 150,
    signature: 500,
  });

  const payroll = calcPayrollByMenu('Олег', [
    { menuItemId: 'classic' },
    { menuItemId: 'grapefruit' },
    { menuItemId: 'pineapple' },
    { menuItemId: 'signature' },
  ], null, 0, [
    { id: 'classic' },
    { id: 'grapefruit' },
    { id: 'pineapple' },
    { id: 'signature' },
  ]);

  assert.equal(payroll, 2800 + 100 + 150 + 150 + 500);
});

test('payroll uses configured salaries for each employee in a shared shift', () => {
  const payroll = calcPayrollByMenu('Амид + Олег', [], null, 0, [], [
    { name: 'Амид', baseSalary: 4000, highVolumeSalary: 6000 },
    { name: 'Олег', baseSalary: 3200, highVolumeSalary: 3200 },
  ]);

  assert.equal(payroll, 7200);
  assert.equal(DEFAULT_EMPLOYEE_SALARIES.find((employee) => employee.name === 'Кирилл')?.baseSalary, 0);
});

test('payroll uses the high-volume salary after 30 hookahs', () => {
  const payroll = calcPayrollByMenu(
    'Олег',
    Array.from({ length: 31 }, () => ({ menuItemId: 'classic' })),
    null,
    0,
    [{ id: 'classic', salaryBonus: 100 }],
    [{ name: 'Олег', baseSalary: 3200, highVolumeSalary: 4200 }],
  );

  assert.equal(payroll, 4200 + 31 * 100);
});

test('joint shifts keep the full bonus pool on top of every base salary', () => {
  const employees = [
    { name: 'Амид', baseSalary: 3300, highVolumeSalary: 5000 },
    { name: 'Олег', baseSalary: 2800, highVolumeSalary: 2800 },
    { name: 'Ренат', baseSalary: 2800, highVolumeSalary: 2800 },
  ];
  const lines = [{ menuItemId: 'classic' }];
  const menu = [{ id: 'classic', salaryBonus: 120 }];

  assert.equal(calcPayrollByMenu('Амид', lines, null, 0, menu, employees), 3420);
  assert.equal(calcPayrollByMenu('Амид + Олег', lines, null, 0, menu, employees), 6220);
  assert.equal(calcPayrollByMenu('Амид + Олег + Ренат', lines, null, 0, menu, employees), 9020);
});

test('percent is split in half between the members of a joint shift', () => {
  const employees = [
    { name: 'Амид', baseSalary: 3300, highVolumeSalary: 5000 },
    { name: 'Олег', baseSalary: 2800, highVolumeSalary: 2800 },
    { name: 'Ренат', baseSalary: 2500, highVolumeSalary: 2500 },
  ];
  const menu = [{ id: 'classic', salaryBonus: 100 }];
  const lines = (count: number) => Array.from({ length: count }, () => ({ menuItemId: 'classic' }));

  // 14 Классики → процент 1400 ₽ делится пополам: по 700 ₽ каждому мастеру.
  assert.equal(calcMasterPayrollShare('Ренат/Амид', 'Ренат', lines(14), menu, employees), 3200);
  assert.equal(calcMasterPayrollShare('Ренат/Амид', 'Амид', lines(14), menu, employees), 4000);
  // Сумма долей = итог смены (таблица за 04.09.2026: 7200 ₽).
  assert.equal(
    3200 + 4000,
    calcPayrollByMenu('Ренат/Амид', lines(14), null, 0, menu, employees),
  );

  // Три участника — процент делится на три.
  assert.equal(
    calcMasterPayrollShare('Амид + Олег + Ренат', 'Олег', lines(30), menu, employees),
    2800 + 1000,
  );

  // Повышенная ставка (>30 кальянов) работает и в доле участника.
  assert.equal(calcMasterPayrollShare('Олег/Амид', 'Амид', lines(31), menu, employees), 5000 + 1550);
  assert.equal(
    calcMasterPayrollShare('Олег/Амид', 'Амид', lines(31), menu, employees) +
      calcMasterPayrollShare('Олег/Амид', 'Олег', lines(31), menu, employees),
    calcPayrollByMenu('Олег/Амид', lines(31), null, 0, menu, employees),
  );

  // «Оклад этой смены» перекрывает оклад одиночного мастера.
  assert.equal(calcMasterPayrollShare('Ренат', 'Ренат', lines(9), menu, employees, 3750), 3750 + 900);
});

test('report range takes a custom week period', () => {
  assert.deepEqual(resolveReportRange('day', '2026-09-15'), {
    from: '2026-09-15',
    to: '2026-09-15',
  });

  // По умолчанию «Неделя» — семь дней, заканчивающихся выбранной датой.
  assert.deepEqual(resolveReportRange('week', '2026-09-15'), {
    from: '2026-09-09',
    to: '2026-09-15',
  });

  // Свой диапазон «с … по …» — можно охватить любое число дней.
  assert.deepEqual(resolveReportRange('week', '2026-09-15', '2026-09-01', '2026-09-30'), {
    from: '2026-09-01',
    to: '2026-09-30',
  });

  // Задан только один край — второй берётся из автоматического диапазона.
  assert.deepEqual(resolveReportRange('week', '2026-09-15', '2026-09-01'), {
    from: '2026-09-01',
    to: '2026-09-15',
  });
  assert.deepEqual(resolveReportRange('week', '2026-09-15', '', '2026-09-20'), {
    from: '2026-09-09',
    to: '2026-09-20',
  });

  // Перепутанные границы меняются местами.
  assert.deepEqual(resolveReportRange('week', '2026-09-15', '2026-09-30', '2026-09-01'), {
    from: '2026-09-01',
    to: '2026-09-30',
  });

  // «Месяц» — календарный месяц, включая февраль високосного года.
  assert.deepEqual(resolveReportRange('month', '2026-09-15'), {
    from: '2026-09-01',
    to: '2026-09-30',
  });
  assert.deepEqual(resolveReportRange('month', '2024-02-10'), {
    from: '2024-02-01',
    to: '2024-02-29',
  });
});

test('shift extra is added to the owner salary', () => {
  const employees = [
    { name: 'Амид', baseSalary: 3300, highVolumeSalary: 5000 },
    { name: 'Олег', baseSalary: 2800, highVolumeSalary: 2800 },
  ];
  const menu = [{ id: 'classic', salaryBonus: 100 }];
  const lines = (count: number) => Array.from({ length: count }, () => ({ menuItemId: 'classic' }));

  const olegShift = { master: 'Олег', amidExtra: 1000, fixedSalary: null };
  assert.equal(getShiftOwnerExtra(olegShift), 1000);
  assert.equal(calcMasterShiftPayout(olegShift, 'Олег', lines(9), menu, employees), 2800 + 900);
  // Амид эту смену не работал — ему уходит только доплата.
  assert.equal(calcMasterShiftPayout(olegShift, 'Амид', lines(9), menu, employees), 1000);
  // Сумма долей (с доплатой) равна итогу смены (с доплатой).
  assert.equal(
    calcMasterShiftPayout(olegShift, 'Олег', lines(9), menu, employees) +
      calcMasterShiftPayout(olegShift, 'Амид', lines(9), menu, employees),
    calcPayrollByMenu('Олег', lines(9), null, 0, menu, employees) + getShiftOwnerExtra(olegShift),
  );

  // Совместная смена: доля участника + доплата владельцу ровно один раз.
  const joint = { master: 'Олег/Амид', amidExtra: 500, fixedSalary: null };
  assert.equal(calcMasterShiftPayout(joint, 'Амид', lines(14), menu, employees), 3300 + 700 + 500);
  assert.equal(calcMasterShiftPayout(joint, 'Олег', lines(14), menu, employees), 2800 + 700);

  // Пустая, отрицательная или отсутствующая доплата не учитывается.
  assert.equal(getShiftOwnerExtra({}), 0);
  assert.equal(getShiftOwnerExtra({ amidExtra: -50 }), 0);
  assert.equal(getShiftOwnerExtra(null), 0);
});

test('september 2026 spreadsheet rows reproduce the payroll formula', () => {
  const employees = [
    { name: 'Амид', baseSalary: 3300, highVolumeSalary: 5000 },
    { name: 'Олег', baseSalary: 2800, highVolumeSalary: 2800 },
    { name: 'Ренат', baseSalary: 2500, highVolumeSalary: 2500 },
  ];
  const menu = [
    { id: 'classic', salaryBonus: 100 },
    { id: 'grapefruit', salaryBonus: 150 },
    { id: 'pineapple', salaryBonus: 150 },
    { id: 'signature', salaryBonus: 500 },
  ];
  const lines = (menuItemId: string, count: number) =>
    Array.from({ length: count }, () => ({ menuItemId }));

  // 04.09.2026: Ренат/Амид, 14 классических — проценты 1400 + выход 5800 = 7200.
  assert.equal(calcPayrollByMenu('Ренат/Амид', lines('classic', 14), null, 0, menu, employees), 7200);

  // 11.09.2026: Ренат/Амид, 25 классических + 1 грейпфрут + 1 авторский — 3150 + 5800 = 8950.
  assert.equal(
    calcPayrollByMenu(
      'Ренат/Амид',
      [...lines('classic', 25), ...lines('grapefruit', 1), ...lines('signature', 1)],
      null,
      0,
      menu,
      employees,
    ),
    8950,
  );

  // 20.09.2026: Олег, 26 классических + 1 грейпфрут — 2750 + 2800 = 5550.
  assert.equal(
    calcPayrollByMenu('Олег', [...lines('classic', 26), ...lines('grapefruit', 1)], null, 0, menu, employees),
    5550,
  );

  // 23.09.2026: Амид, 16 классических — 1600 + 3300 = 4900.
  assert.equal(calcPayrollByMenu('Амид', lines('classic', 16), null, 0, menu, employees), 4900);
});

test('coal consumption follows the spreadsheet formula', () => {
  assert.equal(COAL_KG_PER_HOOKAH, 0.072);
  assert.equal(COAL_KG_PER_REBUILD, 0.036);

  assert.equal(calcCoalUsageKg(10), 0.72);
  assert.equal(calcCoalUsageKg(10, 5), 10 * 0.072 + 5 * 0.036);
  assert.equal(calcCoalUsageKg(0, 0), 0);
});

test('tobacco consumption adds a bowl rebuild on top of the hookah lines', () => {
  assert.equal(TOBACCO_GRAMS_PER_REBUILD, 24);

  assert.equal(
    calcTobaccoUsageGrams([{ tobaccoGrams: 24 }, { tobaccoGrams: 27 }]),
    51,
  );
  assert.equal(calcTobaccoUsageGrams([{ tobaccoGrams: 24 }], 2), 24 + 48);
  assert.equal(calcTobaccoUsageGrams([], 3), 72);
});

test('menu validation catches the values the API rejects', () => {
  assert.equal(MIN_TOBACCO_GRAMS, 1);
  assert.equal(MAX_TOBACCO_GRAMS, 100);

  // Норму чаши задаёт владелец: подходят и привычные 24–27 г, и любые свои веса.
  assert.deepEqual(
    validateMenuItems([
      { id: 'classic', name: 'Классика', price: 1500, tobaccoGrams: 24, salaryBonus: 100 },
      { id: 'berry', name: 'Вишня', price: 2000, tobaccoGrams: 30, salaryBonus: 0 },
      { id: 'mini', name: 'Мини', price: 1200, tobaccoGrams: 18, salaryBonus: 0 },
      { id: 'barbie', name: 'Барби', price: 0, tobaccoGrams: 27 },
    ]),
    [],
  );

  // Одна негодная позиция не должна сохраняться молча — иначе сервер
  // отклоняет состояние целиком, а в интерфейсе не видно причины.
  const issues = validateMenuItems([
    { id: 'grams', name: 'Проба', price: 2000, tobaccoGrams: 0, salaryBonus: 0 },
    { id: 'empty', name: '   ', price: 2000, tobaccoGrams: 27, salaryBonus: 0 },
    { id: 'price', name: 'Без цены', price: Number.NaN, tobaccoGrams: 27, salaryBonus: -1 },
  ]);

  assert.deepEqual(
    issues.map((issue) => `${issue.itemId}.${issue.field}`),
    ['grams.tobaccoGrams', 'empty.name', 'price.price', 'price.salaryBonus'],
  );
  assert.equal(formatMenuIssue(issues[0], 'Проба'), '«Проба»: табак — целое число от 1 до 100 г');
  assert.equal(formatMenuIssue(issues[1], '   '), 'позиция №2: укажите название позиции');
  assert.equal(formatMenuIssue(issues[2], 'Без цены'), '«Без цены»: цена — число не меньше 0');

  // Верхняя граница остаётся, чтобы опечатка вроде 1010 г не искажала расход.
  assert.deepEqual(
    validateMenuItems([{ id: 'huge', name: 'Опечатка', price: 2000, tobaccoGrams: 101 }]).map((i) => i.field),
    ['tobaccoGrams'],
  );
});

test('numeric input keeps manual typing possible', () => {
  // Пустое поле — это 0, а не «невозможно очистить»: именно из-за мгновенного
  // превращения в 0 раньше нельзя было вписать цену, граммовку и доплату.
  assert.equal(parseNumericInput(''), 0);
  assert.equal(parseNumericInput('   '), 0);
  assert.equal(parseNumericInput('2500'), 2500);
  assert.equal(parseNumericInput(' 1500 '), 1500);
  assert.equal(parseNumericInput('2,5'), 2.5);
  assert.equal(parseNumericInput('0.5'), 0.5);
  assert.equal(parseNumericInput('abc'), 0);
  assert.ok(Number.isNaN(parseNumericInput('abc', Number.NaN)));

  // Граммовка набирается вручную и принимается проверкой меню.
  assert.deepEqual(
    validateMenuItems([{ id: 'x', name: 'Новинка', price: parseNumericInput('2200'), tobaccoGrams: parseNumericInput('25'), salaryBonus: parseNumericInput('250') }]),
    [],
  );
});
