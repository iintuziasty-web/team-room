export class CommunityUpdates {
  constructor(options) {
    this.o = options;
    this.request = 0;
    this.checking = false;
    this.timer = null;
  }
  badge() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshBadge(), 30 * 60000);
      setTimeout(() => void this.refreshBadge(), 30000);
    }
    const value = this.o.state()?.updates;
    if (!value?.available) return;
    const button = document.querySelector(".profile-button");
    if (button && !button.querySelector(".community-update-dot")) {
      const dot = document.createElement("span");
      dot.className = "community-update-dot";
      dot.setAttribute("aria-label", "Доступно обновление Team Room");
      dot.title = "Доступна версия " + value.version;
      button.append(dot);
    }
  }
  async refreshBadge() {
    if (!this.o.state()) return;
    try {
      const info = await this.o.api("/updates");
      if (!this.o.state()) return;
      this.o.state().updates = info;
      this.badge();
    } catch {}
  }
  async show(force = false) {
    const token = ++this.request,
      owner = this.o.state()?.me.owner;
    this.o.dialog(
      "Обновления Team Room",
      '<p id="community-updates-loading" role="status">Проверяю версию…</p>',
    );
    const loading = document.querySelector("#community-updates-loading");
    try {
      const value = await this.o.api(
        "/updates" + (force && owner ? "?check=1" : ""),
        "GET",
        undefined,
        { timeoutMs: 30000 },
      );
      if (
        token !== this.request ||
        !loading?.isConnected ||
        !document.querySelector("#dialog")?.open
      )
        return;
      this.render(value);
    } catch (error) {
      if (!loading?.isConnected || !document.querySelector("#dialog")?.open)
        return;
      this.o.dialog(
        "Обновления Team Room",
        '<p role="alert">' +
          this.o.esc(error.message) +
          '</p><button onclick="showCommunityUpdates()">Повторить</button>',
      );
    }
  }
  render(value) {
    const e = this.o.esc,
      owner = this.o.state()?.me.owner;
    const content = `<section class="community-updates"><p class="community-updates-version">Установлена ${e(value.current)}</p><h3>${value.available ? "Доступна версия " + e(value.version) : value.error ? "Проверка недоступна" : value.checkedAt ? "Новых обновлений пока нет" : "Проверка обновлений"}</h3>${value.checkedAt ? '<p class="muted">Последняя проверка: ' + e(new Date(value.checkedAt).toLocaleString()) + "</p>" : ""}${value.error ? '<p role="alert">' + e(value.error) + "</p>" : ""}${value.available ? '<pre class="community-release-notes">' + e(value.notes) + "</pre>" : ""}<p>Обновления добровольные. Программа загружается из публичных релизов, подпись проверяется перед установкой. Ваш сервер, аккаунты и рабочие файлы остаются вашими.</p>${owner ? `<label class="community-update-preference"><input type="checkbox" id="community-update-checks" ${value.enabled ? "checked" : ""}> Проверять новые версии автоматически</label>` : '<p class="muted">Устанавливать серверное обновление может владелец этого пространства.</p>'}${value.lastResult?.ok === false ? '<p class="community-update-warning">' + e(value.lastResult.message) + "</p>" : ""}${value.busy ? '<p class="community-update-warning">Сейчас идёт работа или передача данных. Установка станет доступна после завершения.</p>' : ""}${!value.managed ? '<p class="community-update-warning">Для установки кнопкой один раз обновите хаб из GitHub и запустите через npm start. Новые Docker-сборки уже включают этот механизм.</p>' : ""}<div class="community-update-actions"><button id="community-update-refresh">Проверить обновления</button>${owner && value.available && value.managed ? `<button id="community-update-install" class="primary-button" ${value.busy ? "disabled" : ""}>${value.readyVersion === value.version ? "Установить и перезапустить сервер" : "Подготовить обновление"}</button>` : ""}<a href="https://github.com/iintuziasty-web/team-room/releases" target="_blank" rel="noopener noreferrer">Все релизы ↗</a></div><p id="community-update-feedback" role="status"></p><p class="muted">Mac-приложение обновляется отдельно: меню Team Room → Проверить обновления. Сайт и iPhone получают веб-часть после обновления своего хаба.</p></section>`;
    this.o.dialog("Обновления Team Room", content);
    document.querySelector("#community-update-refresh").onclick = () =>
      this.show(true);
    const toggle = document.querySelector("#community-update-checks");
    if (toggle)
      toggle.onchange = async () => {
        toggle.disabled = true;
        try {
          await this.o.api("/updates", "PATCH", { enabled: toggle.checked });
        } catch (error) {
          toggle.checked = !toggle.checked;
          this.feedback(error.message);
        } finally {
          toggle.disabled = false;
        }
      };
    const install = document.querySelector("#community-update-install");
    if (install) install.onclick = () => void this.install(value, install);
  }
  feedback(text) {
    const node = document.querySelector("#community-update-feedback");
    if (node) node.textContent = text;
  }
  async install(value, button) {
    if (this.checking) return;
    const view = button.closest(".community-updates");
    if (
      value.readyVersion === value.version &&
      !window.confirm(
        "Установить Team Room " +
          value.version +
          "? Сервер ненадолго перезапустится. История и файлы сохранятся.",
      )
    )
      return;
    this.checking = true;
    button.disabled = true;
    try {
      if (value.readyVersion !== value.version) {
        this.feedback(
          "Загружаю и проверяю подпись. Подготовка может занять несколько минут…",
        );
        const next = await this.o.api(
          "/updates/prepare",
          "POST",
          { version: value.version },
          { timeoutMs: 300000 },
        );
        if (view?.isConnected && document.querySelector("#dialog")?.open)
          this.render(next);
      } else {
        await this.o.api(
          "/updates/apply",
          "POST",
          { version: value.version },
          { timeoutMs: 15000 },
        );
        this.feedback("Перезапускаю сервер. Не закрывайте страницу…");
        await this.waitForRestart(value.version);
      }
    } catch (error) {
      this.feedback(error.message);
      button.disabled = false;
    } finally {
      this.checking = false;
    }
  }
  async waitForRestart(version) {
    for (let i = 0; i < 90; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const result = await fetch("/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
        });
        const state = await result.json();
        if (result.ok && state.version === version) {
          location.reload();
          return;
        }
        if (result.ok && i > 15) {
          const status = await this.o.api("/updates");
          if (status.current !== version) {
            this.feedback(
              "Сервер работает на предыдущей версии. Обновление не подтвердило запуск; проверьте журнал сервера.",
            );
            return;
          }
        }
      } catch {}
    }
    this.feedback(
      "Перезапуск занял дольше обычного. История сохранена; обновите страницу и проверьте состояние сервера.",
    );
  }
}
