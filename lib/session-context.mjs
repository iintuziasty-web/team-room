// A context snapshot is per native session, never an account quota or a
// cumulative billing counter. This module also runs on Connect and the Hub.
export const CONTEXT_BUDGET = 350000;
export function mergeContextUsage(previous, context) {
 const {policyOnly,...value}=context;
 if(!policyOnly)return {...previous,...value};
 return {...value,...previous,
  modelWindow:value.modelWindow??previous?.modelWindow??null,
  budgetTokens:Math.min(value.budgetTokens,value.modelWindow??previous?.modelWindow??value.budgetTokens),
  usedTokens:previous?.usedTokens??null};
}
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
export function contextSnapshot(provider, usedTokens, modelWindow = null, extra = {}) {
 const window = count(modelWindow);
 return {provider, usedTokens:count(usedTokens), modelWindow:window,
  budgetTokens:Math.min(CONTEXT_BUDGET, window || CONTEXT_BUDGET),
  updatedAt:new Date().toISOString(), ...extra};
}
export function codexContext(usage) {
 const last = usage?.last;
 // `total` is lifetime spend. `last` describes the latest context after any
 // compaction; cache hits already belong to inputTokens and are not added.
 const tokens = count(last?.totalTokens ?? last?.total_tokens);
 if (tokens === null) return null;
 const snapshot = contextSnapshot('codex', tokens, usage.modelContextWindow ?? usage.model_context_window, {source:'native', compacting:false});
 snapshot.compactAtTokens = Math.min(CONTEXT_BUDGET, snapshot.modelWindow ? Math.floor(snapshot.modelWindow * .9) : CONTEXT_BUDGET);
 return snapshot;
}
export function claudeContext(usage, modelWindow = null) {
 if (count(usage?.input_tokens) === null) return null;
 // Unlike result.usage/modelUsage, assistant message usage is one request.
 const tokens = usage.input_tokens + (count(usage.cache_creation_input_tokens) || 0) +
  (count(usage.cache_read_input_tokens) || 0) + (count(usage.output_tokens) || 0);
 return contextSnapshot('claude', tokens, modelWindow, {source:'last-request', compacting:false});
}
export function contextMeter(context) {
 const used = count(context?.usedTokens), limit = count(context?.budgetTokens);
 return {known:used !== null && limit > 0 && !context?.compacting, usedTokens:used,
  budgetTokens:limit || CONTEXT_BUDGET, percent:used !== null && limit > 0 ? Math.min(100, used / limit * 100) : null};
}
export function sessionContexts(chat) {
 return Object.entries(chat.providerSessions || {}).map(([key, session]) => ({key,
  provider:session.provider || (key.includes(':claude') ? 'claude' : 'codex'),
  deviceId:session.deviceId || key.split(':')[0], accountId:session.accountId || key.split(':').slice(2).join(':'),
  sessionId:session.sessionId || null, context:session.contextUsage || null}));
}
