/**
 * `work`'s result if it is ready within `budgetMs`, otherwise null. The work is
 * not cancelled: it carries on, and a failure after the budget is swallowed so
 * it can never surface as an unhandled rejection. A failure inside the budget
 * is passed on to the caller.
 */
export function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number
): Promise<T | null> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
