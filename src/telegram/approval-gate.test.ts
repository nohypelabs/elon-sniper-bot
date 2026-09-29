import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGate } from './approval-gate';

/** Controllable fake timer — no real waiting. */
function makeFakeTimer() {
  let nextHandle = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const h = ++nextHandle;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number);
    },
    fireAll(): void {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, t] of pending) t.fn();
    },
    fireOne(): void {
      const first = timers.keys().next();
      if (!first.done) {
        const h = first.value;
        const t = timers.get(h)!;
        timers.delete(h);
        t.fn();
      }
    },
    scheduled(): number {
      return timers.size;
    },
  };
}

function makeGate() {
  const fake = makeFakeTimer();
  const gate = new ApprovalGate({ setTimer: fake.setTimer, clearTimer: fake.clearTimer });
  return { gate, fake };
}

describe('approval-gate: approve', () => {
  it('explicit approve resolves approved', async () => {
    const { gate } = makeGate();
    const { id, decision } = gate.open(20_000);
    assert.equal(gate.pending(), 1);
    assert.equal(gate.resolve(id, true), 'ok');
    assert.equal(await decision, 'approved');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: reject', () => {
  it('explicit reject resolves rejected (fail closed)', async () => {
    const { gate } = makeGate();
    const { id, decision } = gate.open(20_000);
    assert.equal(gate.resolve(id, false), 'ok');
    assert.equal(await decision, 'rejected');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: expire', () => {
  it('timeout resolves expired and clears the map', async () => {
    const { gate, fake } = makeGate();
    const { decision } = gate.open(20_000);
    assert.equal(gate.pending(), 1);
    assert.equal(fake.scheduled(), 1);
    fake.fireAll();
    assert.equal(await decision, 'expired');
    assert.equal(gate.pending(), 0);
    assert.equal(fake.scheduled(), 0);
  });
});

describe('approval-gate: late click', () => {
  it('resolve after expiry returns unknown', async () => {
    const { gate, fake } = makeGate();
    const { id, decision } = gate.open(20_000);
    fake.fireAll();
    assert.equal(await decision, 'expired');
    assert.equal(gate.resolve(id, true), 'unknown');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: double click', () => {
  it('second resolve returns unknown and keeps the first decision', async () => {
    const { gate } = makeGate();
    const { id, decision } = gate.open(20_000);
    assert.equal(gate.resolve(id, true), 'ok');
    assert.equal(gate.resolve(id, true), 'unknown');
    assert.equal(gate.resolve(id, false), 'unknown');
    assert.equal(await decision, 'approved');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: unknown id', () => {
  it('resolve of a never-opened id returns unknown', () => {
    const { gate } = makeGate();
    assert.equal(gate.resolve('nope', true), 'unknown');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: concurrent', () => {
  it('two gates get distinct ids and resolve independently', async () => {
    const { gate } = makeGate();
    const a = gate.open(20_000);
    const b = gate.open(20_000);
    assert.notEqual(a.id, b.id);
    assert.equal(gate.pending(), 2);
    assert.equal(gate.resolve(a.id, true), 'ok');
    assert.equal(await a.decision, 'approved');
    // b is untouched
    assert.equal(gate.pending(), 1);
    assert.equal(gate.resolve(b.id, false), 'ok');
    assert.equal(await b.decision, 'rejected');
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: cancelAll', () => {
  it('expires everything pending', async () => {
    const { gate, fake } = makeGate();
    const a = gate.open(20_000);
    const b = gate.open(20_000);
    assert.equal(gate.pending(), 2);
    gate.cancelAll();
    assert.equal(await a.decision, 'expired');
    assert.equal(await b.decision, 'expired');
    assert.equal(gate.pending(), 0);
    assert.equal(fake.scheduled(), 0);
    // Late clicks after cancelAll are unknown
    assert.equal(gate.resolve(a.id, true), 'unknown');
  });

  it('cancelAll on an empty gate is a no-op', () => {
    const { gate } = makeGate();
    gate.cancelAll();
    assert.equal(gate.pending(), 0);
  });
});

describe('approval-gate: callback_data size', () => {
  it('appr:yes:<id> stays <= 64 bytes even for 1e6 ids', () => {
    const { gate } = makeGate();
    let maxLen = 0;
    let prev = -1;
    for (let i = 0; i < 1_000_000; i++) {
      const { id, decision } = gate.open(20_000);
      // Monotonically increasing numeric ids
      const n = Number(id);
      assert.ok(Number.isInteger(n) && n > prev, `id ${id} is not monotonically increasing`);
      prev = n;
      const yesLen = `appr:yes:${id}`.length;
      const noLen = `appr:no:${id}`.length;
      if (yesLen > maxLen) maxLen = yesLen;
      assert.ok(yesLen <= 64, `callback_data too long: ${yesLen}`);
      assert.ok(noLen <= 64, `callback_data too long: ${noLen}`);
      // Resolve immediately so the map stays small; ids still exercised.
      gate.resolve(id, false);
      // Silence unhandled rejection warnings — decision always resolves.
      void decision;
    }
    assert.ok(maxLen <= 64);
    assert.equal(gate.pending(), 0);
  });
});
