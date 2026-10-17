import {CONTEXT_BUDGET} from './session-context.mjs';
export {CONTEXT_BUDGET};
// Only enlarge models with a documented >=400K window. Unknown/small models
// retain the native window; overriding the number cannot add server capacity.
export function codexContextConfig(model) {
 const supported = /^(?:gpt-5\.[23](?:-codex)?|gpt-5\.4|gpt-6(?:\.1)?-(?:sol|astra|luna))(?:$|-\d{4}-)/.test(model || '');
 return {model_auto_compact_token_limit:CONTEXT_BUDGET,
  ...(supported ? {model_context_window:400000} : {})};
}
export function claudeModelWindow(model) {
 if (/\[1m\]|claude-(?:opus|sonnet)-5-5|claude-fable-5-1/i.test(model || '')) return 1000000;
 if (/haiku|claude-(?:opus|sonnet)-4-(?:0|1|5)/i.test(model || '')) return 200000;
 return null;
}
