const paths = {
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m3 0h1m3 0h1m3 0h1M6 13h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  invite: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6m-3-3h6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-4.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function action(name, title, description, method) {
  return `<button type="button" class="profile-menu-action" onclick="${method}()"><span class="profile-menu-icon">${icon(name)}</span><span class="profile-menu-action-copy"><strong>${title}</strong><small>${description}</small></span><span class="profile-menu-chevron">${icon('chevron')}</span></button>`;
}

/** Account names are escaped by the application's existing HTML escaping helper. */
export function renderProfileMenu(state, esc) {
  const me = state?.me || {};
  const members = Array.isArray(state?.members) ? state.members : [];
  const chips = members.map(member => {
    const name = String(member.name || 'Аккаунт');
    const current = member.id != null && me.id != null ? member.id === me.id : name === me.name;
    return `<span class="profile-member${current ? ' profile-member-current' : ''}"><span class="profile-member-avatar" aria-hidden="true">${esc([...name][0] || '?')}</span><span class="profile-member-name">${esc(name)}</span>${current ? '<small>вы</small>' : ''}</span>`;
  }).join('');

  return `<div class="profile-menu">
    <section class="profile-menu-space" aria-labelledby="profile-space-title">
      <h3 id="profile-space-title">Общее пространство</h3>
      <div class="profile-members" aria-label="Участники пространства">${chips}</div>
      <p>Участникам доступны общие чаты, память и файлы.</p>
    </section>
    <div class="profile-menu-actions" aria-label="Настройки аккаунта">
      ${action('keyboard', 'Горячие клавиши', 'Поиск, новый чат и отправка с клавиатуры', 'showShortcuts')}
      ${action('bell', 'Уведомления', 'Вопросы моделей и завершение работы', 'showNotifications')}
      ${me.owner ? action('invite', 'Пригласить аккаунт', 'Доступ к общему пространству', 'showInvite') + action('shield', 'Безопасность входа', 'Telegram-коды и их получатели', 'showSecurity') : ''}
    </div>
    <div class="profile-menu-footer"><button type="button" class="profile-menu-logout" onclick="logout()"><span class="profile-menu-icon">${icon('logout')}</span><span>Выйти из Team Room</span></button></div>
  </div>`;
}
