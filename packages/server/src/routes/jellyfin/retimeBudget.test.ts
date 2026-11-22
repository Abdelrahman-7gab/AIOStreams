import { describe, expect, it } from 'vitest';
import { withinBudget } from './retimeBudget.js';

const later = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe('withinBudget', () => {
  it('gives the result when it is ready in time', async () => {
    expect(await withinBudget(later(5, 'retimed'), 200)).toBe('retimed');
  });

  it('gives null at about the budget when the work is slower, and the work carries on', async () => {
    let finished = false;
    const slow = later(300, 'retimed').then((v) => {
      finished = true;
      return v;
    });
    const started = Date.now();
    expect(await withinBudget(slow, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    expect(finished).toBe(false);
    expect(await slow).toBe('retimed');
    expect(finished).toBe(true);
  });

  it('never leaves an unhandled rejection when the work fails after the budget', async () => {
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRejection);
    const failing = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('cdn reset')), 80)
    );
    expect(await withinBudget(failing, 20)).toBeNull();
    await later(200, null);
    process.off('unhandledRejection', onRejection);
    expect(seen).toEqual([]);
  });

  it('passes a failure inside the budget on to the caller', async () => {
    await expect(
      withinBudget(Promise.reject(new Error('bad')), 200)
    ).rejects.toThrow('bad');
  });
});
