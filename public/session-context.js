// Display fallback only; the native session snapshot supplies its own budget.
export const CONTEXT_BUDGET = 350000;
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
export function contextMeter(context) {
 const used = count(context?.usedTokens), limit = count(context?.budgetTokens);
 return {known:used !== null && limit > 0 && !context?.compacting, usedTokens:used,
  budgetTokens:limit || CONTEXT_BUDGET, percent:used !== null && limit > 0 ? Math.min(100, used / limit * 100) : null};
}
