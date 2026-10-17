// Quota percentages are usage, matching the provider's subscription UI.
import {CONTEXT_BUDGET,contextMeter} from './session-context.js';
// The controller reads the selected route on every update and never fetches on open.
const STALE_AFTER_MS = 10 * 60 * 1000;
const clampPercent = value => Math.min(100, Math.max(0, value));
const providerName = value => value === 'codex' ? 'Codex' : value === 'claude' ? 'Claude' : String(value || 'Провайдер');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => {
 if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
 if (typeof value !== 'string' || !value) return null;
 const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
};
const resetTimestamp = value => finite(value) && value > 0 ? value * 1000 : null;
const windowNames = {
 five_hour: 'Сессия · 5 ч', seven_day: 'Неделя · все модели',
 seven_day_opus: 'Неделя · Opus', seven_day_sonnet: 'Неделя · Sonnet',
 seven_day_haiku: 'Неделя · Haiku', seven_day_fable: 'Неделя · Fable'
};
function durationLabel(minutes, fallback) {
 if (!finite(minutes) || minutes <= 0) return fallback;
 if (minutes === 10080) return 'Недельное окно';
 if (minutes === 1440) return 'Суточное окно';
 if (minutes < 60) return `Окно ${minutes} мин`;
 if (minutes % 1440 === 0) return `Окно ${minutes / 1440} дн`;
 return `Окно ${Number((minutes / 60).toFixed(1))} ч`;
}
function topLevelWindowLabel(limits) {
 const key = limits.rateLimitType || limits.rate_limit_type;
 return windowNames[key] || (typeof key === 'string' && key ? key : 'Окно подписки');
}

/** All provider-reported windows; resetsAt is Unix seconds, utilization a 0–1 ratio. */
export function getUsageWindows(limits, now = Date.now()) {
 if (!limits || typeof limits !== 'object') return [];
 const rows = [];
 const append = (key, label, window, used, group = '', windowType = '') => {
  if (!window || typeof window !== 'object') return;
  const resetsAt = resetTimestamp(window.resetsAt);
  rows.push({key, label, group, windowType, durationMinutes: finite(window.windowDurationMins) ? window.windowDurationMins : null,
   usedPercent: finite(used) ? clampPercent(used) : null,
   resetsAt, expired: resetsAt !== null && resetsAt <= now});
 };
 const buckets = limits.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === 'object'
  ? Object.entries(limits.rateLimitsByLimitId).filter(([, bucket]) => bucket && typeof bucket === 'object') : [];
 const snapshots = buckets.length ? buckets : [['', limits.rateLimits || limits.rate_limits || limits]];
 for (const [limitId, bucket] of snapshots) {
  const group = buckets.length > 1 ? String(bucket.limitName || bucket.limitId || limitId) : '';
  for (const key of ['primary', 'secondary']) {
   const window = bucket[key];
   if (window) append(`${limitId}:${key}`, durationLabel(window.windowDurationMins, key === 'primary' ? 'Основное окно' : 'Дополнительное окно'), window, window.usedPercent, group);
  }
 }
 if (limits.unifiedWindows && typeof limits.unifiedWindows === 'object') {
  for (const [key, window] of Object.entries(limits.unifiedWindows)) {
   append(`claude:${key}`, windowNames[key] || key, window, finite(window?.utilization) ? window.utilization * 100 : null, '', key);
  }
 }
 // Claude can send a single window instead of unifiedWindows.
 if (!rows.length && (finite(limits.utilization) || limits.resetsAt)) {
  append('claude:window', topLevelWindowLabel(limits), limits, finite(limits.utilization) ? limits.utilization * 100 : null, '', limits.rateLimitType || limits.rate_limit_type || '');
 }
 return rows;
}

/** Summary for the small composer trigger. Unknown/expired values stay null. */
export function usageMeterState(catalog, now = Date.now()) {
 const windows = getUsageWindows(catalog?.limits, now);
 const values = windows.filter(window => !window.expired && window.usedPercent !== null).map(window => window.usedPercent);
 const updatedAt = timestamp(catalog?.limitsUpdatedAt);
 const usedPercent = values.length ? Math.max(...values) : null;
 return {usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  known: usedPercent !== null, stale: updatedAt === null || now - updatedAt > STALE_AFTER_MS || updatedAt > now + 5000,
  updatedAt, windowCount: windows.length};
}

/** Weekly windows that affect the selected route. No provider calls or inferred percentages. */
export function weeklyQuotaState(catalog, {provider = '', model = '', online = true} = {}, now = Date.now()) {
 const family = String(model).toLowerCase().match(/opus|sonnet|haiku|fable/)?.[0] || '';
 const windows = getUsageWindows(catalog?.limits, now).filter(window => {
  if (window.expired || window.usedPercent === null) return false;
  if (provider === 'claude') return window.windowType === 'seven_day' || Boolean(family && window.windowType === `seven_day_${family}`);
  if (provider === 'codex') return window.durationMinutes !== null && window.durationMinutes >= 10080;
  return false;
 });
 const window = windows.reduce((highest, item) => !highest || item.usedPercent > highest.usedPercent ? item : highest, null);
 const meter = usageMeterState(catalog, now);
 return {window, known: Boolean(window), warning: Boolean(window && window.usedPercent >= 90),
  usedPercent: window?.usedPercent ?? null, remainingPercent: window ? 100 - window.usedPercent : null,
  saved: meter.stale || online === false || catalog?.connected === false || Boolean(catalog?.refreshPending), updatedAt: meter.updatedAt};
}

export function formatUsagePercent(value) {
 if (!finite(value)) return '';
 if (value > 0 && value < .1) return '<0,1%';
 if (value > 99.9 && value < 100) return '>99,9%';
 return Number(value.toFixed(1)).toLocaleString('ru-RU', {maximumFractionDigits:1}) + '%';
}

function ageLabel(at, now) {
 if (at === null) return 'Время получения неизвестно';
 if (at > now + 5000) return 'Время получения требует проверки';
 const minutes = Math.floor(Math.max(0, now - at) / 60000);
 if (minutes < 1) return 'Получено только что';
 if (minutes < 60) return `Получено ${minutes} мин назад`;
 if (minutes < 1440) return `Получено ${Math.floor(minutes / 60)} ч назад`;
 return `Получено ${new Date(at).toLocaleString('ru-RU', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}`;
}
function resetLabel(at, now) {
 if (at === null) return 'Время сброса недоступно';
 if (at <= now) return 'Окно завершилось · нужны новые данные';
 const minutes = Math.ceil((at - now) / 60000);
 if (minutes < 60) return `Сброс через ${minutes} мин`;
 const hours = Math.floor(minutes / 60), rest = minutes % 60;
 if (hours < 24) return `Сброс через ${hours} ч${rest ? ` ${rest} мин` : ''}`;
 const days = Math.floor(hours / 24), remainingHours = hours % 24;
 return `Сброс через ${days} дн${remainingHours ? ` ${remainingHours} ч` : ''}`;
}
function reportedStatus(limits) {
 const status = limits?.status || limits?.rate_limit_status;
 if (status === 'allowed') return 'Провайдер разрешает запросы';
 if (status === 'allowed_warning') return 'Провайдер предупредил о приближении лимита';
 if (status === 'rejected') return 'Провайдер сообщил о достижении лимита';
 return typeof status === 'string' && status ? `Статус провайдера: ${status}` : '';
}
let popoverSequence = 0;
export function renderSessionContext(row) {
 const context=row.context, meter=contextMeter(context), percent=meter.known?Math.round(meter.percent):null;
 const limit=meter.budgetTokens.toLocaleString('ru-RU'), tokens=meter.known?meter.usedTokens.toLocaleString('ru-RU'):null;
 const scope=[providerName(row.provider),row.projectName,row.deviceName,row.accountName].filter(Boolean).join(' · ');
 const note=context?.compacting?'Сжимаю контекст…':meter.known?`${tokens} / ${limit} токенов`:'Нет данных · появятся при следующем ходе';
 const policy=meter.budgetTokens<CONTEXT_BUDGET?'Модель поддерживает меньше 350 000 токенов.':context?.compactAtTokens&&context.compactAtTokens<meter.budgetTokens?`Автосжатие около ${context.compactAtTokens.toLocaleString('ru-RU')} токенов · запас провайдера.`:row.provider==='claude'?'Автосжатие до заполнения · запас Claude.':'Автосжатие при заполнении.';
 const at=context?.updatedAt?Date.parse(context.updatedAt):NaN;
 const saved=Number.isFinite(at)?` · данные ${new Date(at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`:'';
 return `<div class="usage-window usage-session ${row.selected?'usage-session-selected':''}" data-level="${percent>=95?'danger':percent>=80?'warning':'normal'}"><div class="usage-window-line"><span>${escapeHtml(row.title)}${row.selected?' · текущая':''}</span><strong>${percent===null?'—':percent+'%'}</strong></div><div class="usage-bucket">${escapeHtml(scope)}</div><div class="usage-track ${meter.known?'':'usage-track-unknown'}" ${meter.known?`role="progressbar" aria-label="Контекст: ${escapeHtml(row.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${meter.percent}" aria-valuetext="${escapeHtml(note)}"`:'aria-hidden="true"'}><span style="width:${meter.known?meter.percent:0}%"></span></div><div class="usage-reset">${escapeHtml(note)}</div><div class="usage-reset">${escapeHtml(policy)}</div>${context?.compactedAt?'<div class="usage-reset">Контекст сжат</div>':''}<div class="usage-context-age">${escapeHtml((context?.source==='last-request'?'По последнему запросу':'Последние данные провайдера')+saved)}</div></div>`;
}

/**
 * getData(): {catalog, route:{deviceId,deviceName,provider,accountId,accountName,model,modelName}, online?, busy?}
 * getAnchor(): the current composer trigger; onRefresh(route) is an optional explicit read-only refresh.
 * onDetails(): opens the subscription settings after closing this popover.
 * Call update() from renderStatus; close() during logout. No requests run automatically.
 */
export class UsagePopover {
 constructor({getData, getAnchor, onRefresh, onDetails} = {}) {
  if (typeof getData !== 'function' || typeof getAnchor !== 'function') throw new TypeError('UsagePopover needs getData and getAnchor callbacks');
  this.getData = getData; this.getAnchor = getAnchor; this.onRefresh = onRefresh; this.onDetails = onDetails;
  this.id = `usage-popover-${++popoverSequence}`;
  this.element = null; this.isOpen = false; this.anchor = null; this.explicitAnchor = null; this.returnFocus = null;
  this.routeKey = ''; this.renderKey = ''; this.refreshGeneration = 0; this.refreshing = false; this.refreshError = '';
  this.positionFrame = 0; this.timer = null;
  this.outside = event => {
   if (!this.element?.contains(event.target) && !this.currentAnchor()?.contains(event.target)) this.close({restoreFocus:false});
  };
  this.onKey = event => {
   if (event.key === 'Escape' && this.isOpen) {event.preventDefault(); event.stopPropagation(); this.close();}
  };
  this.schedulePosition = () => {
   if (!this.positionFrame && this.isOpen) this.positionFrame = requestAnimationFrame(() => {this.positionFrame = 0; this.position();});
  };
 }
 current() {
  const data = this.getData() || {}, route = data.route || {}, catalog = data.catalog || {};
  return {data, route, catalog, key:JSON.stringify([route.deviceId || '', route.provider || '', route.accountId || '', catalog.accountKey || ''])};
 }
 anchorVisible(anchor) {return Boolean(anchor?.isConnected && !anchor.hidden && anchor.getClientRects().length && getComputedStyle(anchor).visibility !== 'hidden');}
 currentAnchor() {
  if (this.isOpen && this.explicitAnchor) {
   if (this.anchorVisible(this.explicitAnchor)) return this.explicitAnchor;
   this.explicitAnchor = null;
  }
  const fallback = this.getAnchor(); return this.anchorVisible(fallback) ? fallback : null;
 }
 bindAnchor(anchor = this.currentAnchor()) {
  if (this.anchor && this.anchor !== anchor) {this.anchor.setAttribute('aria-expanded', 'false'); this.anchor.removeAttribute('aria-controls');}
  this.anchor = anchor;
  if (anchor) {
   anchor.setAttribute('aria-haspopup', 'dialog'); anchor.setAttribute('aria-controls', this.id);
   anchor.setAttribute('aria-expanded', String(this.isOpen));
  }
 }
 toggle(anchor) {if (this.isOpen) this.close(); else this.open(anchor);}
 open(anchor = this.getAnchor()) {
  if (this.isOpen) {this.update(); return;}
  this.explicitAnchor = anchor || null;
  this.returnFocus = anchor || document.activeElement;
  if (!this.element) {
   this.element = document.createElement('section'); this.element.id = this.id;
   this.element.className = 'usage-popover'; this.element.setAttribute('role', 'dialog');
   this.element.setAttribute('aria-modal', 'false'); this.element.setAttribute('aria-labelledby', `${this.id}-title`);
   this.element.tabIndex = -1;
   this.element.addEventListener('click', event => {
    if (event.target.closest('[data-usage-close]')) this.close();
    else if (event.target.closest('[data-usage-refresh]')) void this.refresh();
    else if (event.target.closest('[data-usage-details]') && typeof this.onDetails === 'function') {this.close(); this.onDetails();}
   });
  }
  this.isOpen = true; this.element.hidden = false; document.body.append(this.element);
  this.bindAnchor(); this.update();
  document.addEventListener('pointerdown', this.outside, true);
  document.addEventListener('keydown', this.onKey, true);
  window.addEventListener('resize', this.schedulePosition);
  document.addEventListener('scroll', this.schedulePosition, true);
  window.visualViewport?.addEventListener('resize', this.schedulePosition);
  window.visualViewport?.addEventListener('scroll', this.schedulePosition);
  this.timer = setInterval(() => this.update(), 15000);
  this.element.focus({preventScroll:true});
 }
 close({restoreFocus = true} = {}) {
  if (!this.isOpen) {this.explicitAnchor = null; this.bindAnchor(); return;}
  const focusWasInside = this.element?.contains(document.activeElement);
  this.isOpen = false; this.explicitAnchor = null; this.refreshGeneration++; this.refreshing = false; this.refreshError = ''; this.renderKey = '';
  this.element.hidden = true; this.element.remove(); this.bindAnchor();
  clearInterval(this.timer); this.timer = null;
  if (this.positionFrame) cancelAnimationFrame(this.positionFrame); this.positionFrame = 0;
  document.removeEventListener('pointerdown', this.outside, true);
  document.removeEventListener('keydown', this.onKey, true);
  window.removeEventListener('resize', this.schedulePosition);
  document.removeEventListener('scroll', this.schedulePosition, true);
  window.visualViewport?.removeEventListener('resize', this.schedulePosition);
  window.visualViewport?.removeEventListener('scroll', this.schedulePosition);
  if (restoreFocus && focusWasInside) {
   const target = this.anchorVisible(this.returnFocus) ? this.returnFocus : this.currentAnchor();
   target?.focus({preventScroll:true});
  }
  this.returnFocus = null;
 }
 update() {
  this.bindAnchor(); if (!this.isOpen) return;
  const {data, route, catalog, key} = this.current(), now = Date.now();
  if (this.routeKey !== key) {
   this.routeKey = key; this.refreshGeneration++; this.refreshing = false; this.refreshError = '';
  }
  const windows = getUsageWindows(catalog.limits, now), meter = usageMeterState(catalog, now);
  const snapshot = JSON.stringify([key, route, windows, meter.stale, catalog.connected, catalog.refreshPending,
   data.online, data.busy, data.sessions, this.refreshing, this.refreshError, reportedStatus(catalog.limits)]);
  if (this.renderKey !== snapshot) {
   const focused = this.element.contains(document.activeElement) ? document.activeElement?.dataset?.usageAction : null;
   this.renderKey = snapshot;
   const scope = [route.accountName || 'Основной аккаунт', route.deviceName || route.deviceId].filter(Boolean).join(' · ');
   const sessions=data.sessions||[],current=sessions.filter(row=>row.selected),others=sessions.filter(row=>!row.selected);
   const contexts=`<section class="usage-contexts"><h3>Контекст сессий · до 350 000 токенов</h3>${current.map(renderSessionContext).join('')}${others.length?`<details class="usage-other-sessions"><summary>Остальные сессии · ${others.length}</summary><div class="usage-session-list">${others.map(renderSessionContext).join('')}</div></details>`:''}${!sessions.length?'<p class="usage-reset">Данные появятся при следующем ходе.</p>':''}</section>`;
   const rows = windows.map(window => {
    const known = window.usedPercent !== null && !window.expired;
    const level = known && window.usedPercent >= 95 ? 'danger' : known && window.usedPercent >= 80 ? 'warning' : 'normal';
    const percent = known ? window.usedPercent.toFixed(0) : null;
    return `<div class="usage-window" data-level="${level}">${window.group ? `<div class="usage-bucket">${escapeHtml(window.group)}</div>` : ''}<div class="usage-window-line"><span>${escapeHtml(window.label)}</span><strong>${known ? `Использовано ${percent}%` : 'Нет данных'}</strong></div><div class="usage-track ${known ? '' : 'usage-track-unknown'}" ${known ? `role="progressbar" aria-label="${escapeHtml([window.group, window.label].filter(Boolean).join(' · '))}: использовано" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${window.usedPercent}" aria-valuetext="Использовано ${percent}%"` : 'aria-hidden="true"'}><span style="width:${known ? window.usedPercent : 0}%"></span></div><div class="usage-reset" data-reset="${window.resetsAt ?? ''}" ${window.resetsAt ? `title="${escapeHtml(new Date(window.resetsAt).toLocaleString('ru-RU'))}"` : ''}>${escapeHtml(resetLabel(window.resetsAt, now))}</div></div>`;
   }).join('');
   let unavailable = '';
   if (!windows.length) {
    const status = reportedStatus(catalog.limits), expired = resetTimestamp(catalog.limits?.resetsAt);
    const note = expired !== null && expired <= now ? 'Окно завершилось. Провайдер пока не передал новые данные.' : status || (catalog.connected === false ? 'Подписка не подключена на выбранном компьютере.' : 'Провайдер пока не передал лимиты этого аккаунта.');
    unavailable = `<div class="usage-unavailable"><strong>Точные проценты недоступны</strong><p>${escapeHtml(note)}</p>${route.provider === 'claude' && catalog.connected !== false ? '<p>Claude передаёт данные во время обычных запросов.</p>' : ''}</div>`;
   }
   const condition = data.online === false ? 'Компьютер отключён · показаны сохранённые данные' : catalog.refreshPending && windows.length ? 'Проверка задержалась · показаны последние данные' : meter.stale && windows.length ? 'Сохранённые данные · значения могли измениться' : '';
   const actions = `${typeof this.onDetails === 'function' ? '<button type="button" class="usage-details" data-usage-details data-usage-action="details" title="Подключение и настройки подписки">Настройки</button>' : ''}${typeof this.onRefresh === 'function' ? `<button type="button" class="usage-refresh" data-usage-refresh data-usage-action="refresh" ${this.refreshing || data.busy ? 'disabled' : ''}>${this.refreshing || data.busy ? 'Обновляю…' : 'Обновить'}</button>` : ''}`;
   const othersOpen=this.element.querySelector('.usage-other-sessions')?.open;
   this.element.innerHTML = `<header class="usage-header"><div><h2 id="${this.id}-title">${escapeHtml(providerName(route.provider))} · лимиты</h2><p class="usage-route" title="${escapeHtml(scope)}">${escapeHtml(scope)}</p></div><button type="button" class="usage-close" data-usage-close data-usage-action="close" aria-label="Закрыть лимиты">×</button></header>${route.modelName || route.model ? `<div class="usage-model" title="${escapeHtml(route.model || route.modelName)}">${escapeHtml(route.modelName || route.model)}</div>` : ''}${contexts}<h3 class="usage-section-title">Лимиты подписки</h3><div class="usage-windows">${rows || unavailable}</div><footer class="usage-footer"><div class="usage-freshness"><span data-usage-age></span>${condition ? `<span class="usage-condition">${escapeHtml(condition)}</span>` : ''}${this.refreshError ? `<span class="usage-refresh-error" role="status">${escapeHtml(this.refreshError)}</span>` : ''}</div>${actions ? `<div class="usage-footer-actions">${actions}</div>` : ''}</footer>`;
   if(othersOpen&&this.element.querySelector('.usage-other-sessions'))this.element.querySelector('.usage-other-sessions').open=true;
   if (focused) {
    const target = this.element.querySelector(`[data-usage-action="${focused}"]`);
    (target && !target.disabled ? target : this.element).focus({preventScroll:true});
   }
  }
  const age = this.element.querySelector('[data-usage-age]');
  if (age) {age.textContent = ageLabel(meter.updatedAt, now); age.title = meter.updatedAt !== null ? new Date(meter.updatedAt).toLocaleString('ru-RU') : '';}
  for (const node of this.element.querySelectorAll('[data-reset]')) node.textContent = resetLabel(node.dataset.reset ? Number(node.dataset.reset) : null, now);
  this.position();
 }
 async refresh() {
  if (!this.isOpen || this.refreshing || typeof this.onRefresh !== 'function') return;
  const {route, key} = this.current(), generation = ++this.refreshGeneration;
  this.refreshing = true; this.refreshError = ''; this.update();
  try {await this.onRefresh({...route});}
  catch {
   if (this.isOpen && this.current().key === key && this.refreshGeneration === generation) this.refreshError = 'Не удалось обновить. Попробуйте ещё раз.';
  } finally {
   if (this.isOpen && this.refreshGeneration === generation) {this.refreshing = false; this.update();}
  }
 }
 position() {
  if (!this.isOpen || !this.element) return;
  const anchor = this.currentAnchor(), viewport = window.visualViewport;
  const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
  const width = viewport?.width || document.documentElement.clientWidth;
  const height = viewport?.height || window.innerHeight;
  const gap = 8, margin = Math.min(12, width / 10);
  this.element.style.width = `${Math.min(360, Math.max(0, width - margin * 2))}px`;
  this.element.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
  const bounds = this.element.getBoundingClientRect();
  const target = anchor?.getBoundingClientRect() || {left:leftEdge + margin, right:leftEdge + width - margin, top:topEdge + height - margin, bottom:topEdge + height - margin};
  const left = Math.max(leftEdge + margin, Math.min(target.right - bounds.width, leftEdge + width - bounds.width - margin));
  const above = target.top - gap - bounds.height;
  const below = target.bottom + gap;
  let top = above >= topEdge + margin ? above : below + bounds.height <= topEdge + height - margin ? below : above;
  top = Math.max(topEdge + margin, Math.min(top, topEdge + height - bounds.height - margin));
  this.element.style.left = `${Math.round(left)}px`; this.element.style.top = `${Math.round(top)}px`;
 }
 destroy() {
  this.close({restoreFocus:false}); this.element?.remove(); this.element = null;
  if (this.anchor) {this.anchor.removeAttribute('aria-controls'); this.anchor.setAttribute('aria-expanded', 'false');}
  this.anchor = null; this.explicitAnchor = null;
 }
}
