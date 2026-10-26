import test from 'node:test';
import assert from 'node:assert/strict';

// Дефолтные PIN не должны зависеть от окружения машины, где гоняют тесты.
delete process.env.POS_ADMIN_PIN;
delete process.env.POS_WORKER_PIN;

import {
  DEFAULT_PINS,
  defaultPin,
  findPinConflict,
  hashPin,
  isValidPin,
  matchesPin,
  normalizePinsRecord,
  roleForPin,
  roleLabel,
  verifyPin,
} from '../artifacts/api-server/src/lib/pins.ts';

test('pin validation accepts only four digits', () => {
  assert.equal(isValidPin('0000'), true);
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('9999'), true);
  for (const value of ['', '123', '12345', '12a4', ' 1234', '1234 ', 'abcd', null, undefined, 1234]) {
    assert.equal(isValidPin(value), false, `должен отклонить ${JSON.stringify(value)}`);
  }
});

test('pins are stored as salted scrypt hashes', () => {
  const first = hashPin('2580');
  const second = hashPin('2580');
  assert.equal(first.salt.length, 32);
  assert.equal(first.hash.length, 64);
  // Разная соль — разный хеш даже для одинакового PIN.
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(verifyPin('2580', first), true);
  assert.equal(verifyPin('2580', second), true);
  assert.equal(verifyPin('2581', first), false);
  assert.equal(verifyPin('', first), false);
});

test('broken hash records are rejected instead of throwing', () => {
  assert.equal(verifyPin('2580', null), false);
  assert.equal(verifyPin('2580', undefined), false);
  assert.equal(verifyPin('2580', { salt: '', hash: '' }), false);
  assert.equal(verifyPin('2580', { salt: 'ab', hash: 'not-hex' }), false);
  assert.equal(verifyPin('2580', { salt: 'ab', hash: 'cd' }), false);
});

test('default pin comparison stays constant-time safe and strict', () => {
  assert.equal(DEFAULT_PINS.admin, '0000');
  assert.equal(DEFAULT_PINS.worker, '1111');
  assert.equal(defaultPin('admin'), '0000');
  assert.equal(matchesPin('0000', '0000'), true);
  assert.equal(matchesPin('0000', '00000'), false);
  assert.equal(matchesPin('0001', '0000'), false);
});

test('environment variables override defaults only while no custom pin is set', () => {
  process.env.POS_ADMIN_PIN = '4321';
  try {
    assert.equal(defaultPin('admin'), '4321');
    assert.equal(roleForPin('4321', null), 'admin');
    // Свой сохранённый код отключает дефолт (в том числе из окружения).
    assert.equal(roleForPin('4321', { admin: hashPin('1357') }), null);
    assert.equal(roleForPin('1357', { admin: hashPin('1357') }), 'admin');
  } finally {
    delete process.env.POS_ADMIN_PIN;
  }
});

test('role lookup uses defaults until the owner sets a custom pin', () => {
  assert.equal(roleForPin('0000'), 'admin');
  assert.equal(roleForPin('1111'), 'worker');
  assert.equal(roleForPin('0001'), null);
  assert.equal(roleForPin('000'), null);

  const record = { admin: hashPin('2468'), worker: hashPin('1357') };
  assert.equal(roleForPin('2468', record), 'admin');
  assert.equal(roleForPin('1357', record), 'worker');
  // Старые дефолтные коды больше не работают.
  assert.equal(roleForPin('0000', record), null);
  assert.equal(roleForPin('1111', record), null);
});

test('admin and worker pins must differ', () => {
  assert.equal(findPinConflict({ adminPin: '1234', workerPin: '1234' }), 'PIN администратора и PIN работника должны различаться');
  assert.equal(findPinConflict({ adminPin: '1234', workerPin: '5678' }), null);
  // Меняется только код работника, администратор пока на дефолте 0000.
  assert.equal(findPinConflict({ workerPin: '0000' }, null), 'PIN администратора и PIN работника должны различаться');
  assert.equal(findPinConflict({ workerPin: '1111' }, null), null);
  // Для роли со своим сохранённым кодом открытого значения нет — сравнить нельзя.
  assert.equal(findPinConflict({ workerPin: '0000' }, { admin: hashPin('2468') }), null);
});

test('stored pin records are sanitized', () => {
  assert.equal(normalizePinsRecord(null), null);
  assert.equal(normalizePinsRecord('nope'), null);
  assert.equal(normalizePinsRecord({}), null);
  const record = normalizePinsRecord({
    admin: { salt: 'aa', hash: 'bb' },
    worker: { salt: '', hash: '' },
    updatedAt: '2026-10-26T10:00:00.000Z',
    extra: 'ignored',
  });
  assert.deepEqual(record, {
    admin: { salt: 'aa', hash: 'bb' },
    updatedAt: '2026-10-26T10:00:00.000Z',
  });
  assert.equal(roleLabel('admin'), 'PIN администратора');
  assert.equal(roleLabel('worker'), 'PIN работника');
});
