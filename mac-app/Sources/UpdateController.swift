import AppKit

@MainActor
final class UpdateController: NSWindowController {
    private let helper: NativeHelper
    private let titleLabel = NSTextField(labelWithString: "Проверяю обновления…")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let button = NSButton(title: "Проверить снова", target: nil, action: nil)
    private var phase = "check"
    private var busy = false
    init(helper: NativeHelper) {
        self.helper = helper
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Обновление Team Room"; window.isReleasedWhenClosed = false; window.appearance = NSAppearance(named: .darkAqua)
        super.init(window: window)
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold); detail.textColor = .secondaryLabelColor
        button.target = self; button.action = #selector(action)
        let stack = NSStackView(views: [titleLabel, detail, button]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
    }
    required init?(coder: NSCoder) { fatalError("Unavailable") }
    func present() { window?.center(); showWindow(nil); window?.makeKeyAndOrderFront(nil); if !busy && phase != "install" { check() } }
    func receiveEvent(_ packet: [String: Any]) { if packet["event"] as? String == "update" { detail.stringValue = packet["message"] as? String ?? "Подготавливаю обновление…" } }
    private func check() {
        busy = true; button.isEnabled = false; titleLabel.stringValue = "Проверяю обновления…"
        helper.request("updateStatus") { [weak self] result in
            guard let self else { return }; self.busy = false; self.button.isEnabled = true
            switch result {
            case .success(let info):
                if info["available"] as? Bool == true {
                    self.titleLabel.stringValue = "Доступна версия \(info["version"] as? String ?? "")"
                    self.detail.stringValue = info["notes"] as? String ?? "Новая версия Team Room."
                    self.phase = "prepare"; self.button.title = "Загрузить обновление"
                } else {
                    self.titleLabel.stringValue = "Установлена версия \(info["current"] as? String ?? "")"; self.detail.stringValue = info["message"] as? String ?? "Обновлений пока нет."; self.phase = "check"; self.button.title = "Проверить снова"
                }
            case .failure(let error): self.failed(error)
            }
        }
    }
    private func failed(_ error: Error) { titleLabel.stringValue = "Обновление не установлено"; detail.stringValue = error.localizedDescription; phase = "check"; busy = false; button.isEnabled = true; button.title = "Проверить снова" }
    @objc private func action() {
        guard !busy else { return }
        if phase == "check" { check(); return }
        if phase == "prepare" {
            busy = true; button.isEnabled = false; titleLabel.stringValue = "Подготавливаю обновление…"
            helper.request("prepareUpdate", timeout: 900) { [weak self] result in
                guard let self else { return }; self.busy = false; self.button.isEnabled = true
                switch result {
                case .success(let info):
                    if info["ready"] as? Bool == true { self.titleLabel.stringValue = "Версия \(info["version"] as? String ?? "") готова"; self.detail.stringValue = "Перезапустится только окно приложения. Фоновое подключение продолжит выполнять задачи."; self.phase = "install"; self.button.title = "Установить и перезапустить" }
                    else { self.phase = "check"; self.check() }
                case .failure(let error): self.failed(error)
                }
            }
        } else if phase == "install" {
            busy = true; button.isEnabled = false
            helper.request("installUpdate") { [weak self] result in
                guard let self else { return }
                switch result {
                case .success: NSApp.terminate(nil)
                case .failure(let error): self.failed(error)
                }
            }
        }
    }
}
