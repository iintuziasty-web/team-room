import AppKit
import WebKit
import UniformTypeIdentifiers

private var roomURL: URL!
@MainActor
private func selectCommunityHub() -> URL? {
    func clean(_ value: String?) -> URL? {
        guard let value, var c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, ["", "/"].contains(c.path),
              c.scheme?.lowercased() == "https" || (c.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())) else { return nil }
        c.scheme = c.scheme?.lowercased(); c.host = host.lowercased(); if (c.scheme == "https" && c.port == 443) || (c.scheme == "http" && c.port == 80) { c.port = nil }
        return c.url
    }
    if let saved = clean(UserDefaults.standard.string(forKey: "communityHubURL")) { return saved }
    if let initial = clean(Bundle.main.object(forInfoDictionaryKey: "TeamRoomHubURL") as? String) {
        UserDefaults.standard.set(initial.absoluteString, forKey: "communityHubURL"); return initial
    }
    let field = NSTextField(string: ""); field.placeholderString = "https://your-hub.example"; field.frame = NSRect(x: 0, y: 0, width: 400, height: 28)
    let alert = NSAlert(); alert.messageText = "Адрес вашего Team Room"; alert.informativeText = "Укажите свой HTTPS-сервер. Приложение не подключается к чужому пространству автоматически. Адрес сохранится при обновлении программы."; alert.accessoryView = field
    alert.addButton(withTitle: "Подключиться"); alert.addButton(withTitle: "Отмена")
    while alert.runModal() == .alertFirstButtonReturn {
        if let url = clean(field.stringValue) { UserDefaults.standard.set(url.absoluteString, forKey: "communityHubURL"); return url }
        alert.informativeText = "Нужен HTTPS-адрес без пути, параметров и пароля. HTTP разрешён только для localhost."
    }
    return nil
}
private let brandBackground = NSColor(srgbRed: 0.082, green: 0.082, blue: 0.082, alpha: 1)
private let brandAccent = NSColor(srgbRed: 0.843, green: 0.467, blue: 0.341, alpha: 1)

private func trusted(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme?.lowercased() == roomURL.scheme && url.host?.lowercased() == roomURL.host && url.port == roomURL.port && url.user == nil && url.password == nil
}
private func applicationPage(_ url: URL?) -> Bool { trusted(url) && ["/", "/room", "/room/"].contains(url?.path ?? "") }
private func safeExternal(_ url: URL) -> Bool {
    ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") && url.user == nil && url.password == nil
}

@MainActor
final class NativeHelper {
    private var process: Process?
    private var input: FileHandle?
    private var output = Data()
    private var sequence = 0
    private var callbacks: [String: (Result<[String: Any], Error>) -> Void] = [:]
    var event: (([String: Any]) -> Void)?
    private var startupError: Error?

    init() {
        guard let resources = Bundle.main.resourceURL else { return }
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        let node = resources.appendingPathComponent("runtime/\(architecture)/bin/node")
        let helper = resources.appendingPathComponent("desktop/helper.mjs")
        let p = Process(), stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        p.executableURL = node
        p.arguments = [helper.path]
        var environment = ProcessInfo.processInfo.environment
        environment["TEAMROOM_BUNDLE_ROOT"] = resources.path
        environment["TEAMROOM_HUB_URL"] = roomURL.absoluteString
        environment["TEAMROOM_APP_PATH"] = Bundle.main.bundlePath
        environment["TEAMROOM_APP_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        environment["PATH"] = resources.appendingPathComponent("runtime/\(architecture)/bin").path + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        p.environment = environment
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = stderr
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if !bytes.isEmpty { Task { @MainActor in self?.receive(bytes) } }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let error = NSError(domain: "TeamRoom", code: 1, userInfo: [NSLocalizedDescriptionKey: "Фоновая настройка недоступна. Закрой и открой приложение снова."])
                self.startupError = error
                let pending = self.callbacks; self.callbacks.removeAll()
                for callback in pending.values { callback(.failure(error)) }
            }
        }
        do { try p.run(); process = p; input = stdin.fileHandleForWriting }
        catch { startupError = error }
    }
    private func receive(_ bytes: Data) {
        output.append(bytes)
        if output.count > 2 * 1024 * 1024 { output.removeAll(); return }
        while let newline = output.firstIndex(of: 10) {
            let line = Data(output[..<newline]); output.removeSubrange(...newline)
            guard let packet = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if packet["type"] as? String == "event" { event?(packet); continue }
            guard let id = packet["id"] as? String, let callback = callbacks.removeValue(forKey: id) else { continue }
            if packet["ok"] as? Bool == true { callback(.success(packet["result"] as? [String: Any] ?? [:])) }
            else {
                let message = packet["error"] as? String ?? (packet["error"] as? [String: Any])?["message"] as? String ?? "Не удалось выполнить настройку компьютера."
                callback(.failure(NSError(domain: "TeamRoom", code: 1, userInfo: [NSLocalizedDescriptionKey: message])))
            }
        }
    }
    func request(_ action: String, _ payload: [String: Any] = [:], timeout: TimeInterval = 240, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if let error = startupError { completion(.failure(error)); return }
        guard process?.isRunning == true, let input else { completion(.failure(NSError(domain: "TeamRoom", code: 1, userInfo: [NSLocalizedDescriptionKey: "Настройка компьютера пока недоступна."]))); return }
        sequence += 1; let id = String(sequence)
        callbacks[id] = completion
        do {
            var bytes = try JSONSerialization.data(withJSONObject: ["id": id, "action": action, "payload": payload])
            bytes.append(10); try input.write(contentsOf: bytes)
        } catch { callbacks.removeValue(forKey: id)?(.failure(error)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            self?.callbacks.removeValue(forKey: id)?(.failure(NSError(domain: "TeamRoom", code: 1, userInfo: [NSLocalizedDescriptionKey: "Настройка заняла слишком долго. Открой «Этот Mac», чтобы проверить состояние."])))
        }
    }
    func close() { try? input?.close(); if process?.isRunning == true { process?.terminate() } }
}

@MainActor
private final class SettingsDocumentView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
final class ComputerController: NSWindowController {
    private let helper: NativeHelper
    private let headline = NSTextField(labelWithString: "Проверяю подключение…")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let chooser = NSPopUpButton(frame: .zero, pullsDown: false)
    private var candidates: [[String: Any]] = []
    private var polling: Timer?
    weak var roomWindow: RoomWindow?
    private var pairing = false

    init(helper: NativeHelper) {
        self.helper = helper
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 640), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Этот Mac — Team Room"
        window.minSize = NSSize(width: 520, height: 400)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = brandBackground
        super.init(window: window)
        headline.font = .systemFont(ofSize: 21, weight: .semibold)
        detail.font = .systemFont(ofSize: 13)
        detail.textColor = .secondaryLabelColor
        notice.font = .systemFont(ofSize: 12)
        notice.textColor = .secondaryLabelColor
        chooser.isHidden = true
        let intro = NSTextField(wrappingLabelWithString: "Это окно настраивает компьютер, который выполняет задачи. Сам Team Room использует твои существующие проекты, чаты, память и файлы.")
        intro.font = .systemFont(ofSize: 13)
        intro.textColor = .secondaryLabelColor
        let setup = button("Подключить этот Mac", #selector(setupDevice))
        setup.bezelColor = brandAccent
        let importButton = button("Открыть архив подключения…", #selector(importArchive))
        let start = button("Включить существующее подключение", #selector(startExisting))
        let claude = button("Войти в Claude", #selector(loginClaude))
        let codex = button("Войти в Codex", #selector(loginCodex))
        let loginRow = NSStackView(views: [claude, codex]); loginRow.spacing = 8
        let refresh = button("Обновить состояние", #selector(refresh))
        let updateImport = button("Обновить подключение", #selector(updateImport))
        let storage = button("Перенести на внешний диск…", #selector(moveStorage))
        let footer = NSTextField(wrappingLabelWithString: "Подключение работает в фоне. Закрытие приложения или его окна не останавливает задачи. Входы в Claude и Codex остаются на этом Mac.")
        footer.font = .systemFont(ofSize: 12); footer.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [headline, detail, intro, chooser, setup, importButton, start, loginRow, updateImport, storage, refresh, notice, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setContentHuggingPriority(.required, for: .vertical)
        stack.setContentCompressionResistancePriority(.required, for: .vertical)
        for view in stack.arrangedSubviews { view.setContentCompressionResistancePriority(.required, for: .vertical) }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.drawsBackground = false; scroll.contentView.drawsBackground = false
        scroll.borderType = .noBorder; scroll.translatesAutoresizingMaskIntoConstraints = false
        let document = SettingsDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack); scroll.documentView = document
        window.contentView?.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -26),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -22),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            intro.widthAnchor.constraint(equalTo: stack.widthAnchor),
            notice.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        helper.event = { [weak self] packet in self?.receiveEvent(packet) }
    }
    required init?(coder: NSCoder) { fatalError("Unavailable") }
    private func button(_ title: String, _ selector: Selector) -> NSButton { NSButton(title: title, target: self, action: selector) }
    func present() {
        window?.center(); showWindow(nil); window?.makeKeyAndOrderFront(nil); refresh()
        if polling == nil { polling = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in Task { @MainActor in if self?.window?.isVisible == true { self?.refresh() } } } }
    }
    @objc func refresh() {
        helper.request("status") { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.headline.stringValue = "Настройка недоступна"; self.detail.stringValue = error.localizedDescription
            case .success(let info):
                self.roomWindow?.updateLocalDevice(info)
                let selectedId = self.candidates[safe: self.chooser.indexOfSelectedItem]?["id"] as? String
                self.candidates = info["connections"] as? [[String: Any]] ?? []
                self.chooser.removeAllItems()
                for item in self.candidates { self.chooser.addItem(withTitle: item["name"] as? String ?? "Этот Mac") }
                let currentId = (info["current"] as? [String: Any])?["id"] as? String
                let selectedIndex = self.candidates.firstIndex { $0["id"] as? String == selectedId }
                    ?? self.candidates.firstIndex { $0["id"] as? String == currentId } ?? 0
                if !self.candidates.isEmpty { self.chooser.selectItem(at: selectedIndex) }
                self.chooser.isHidden = self.candidates.count < 2
                let connected = info["connected"] as? Bool ?? false
                let running = info["running"] as? Int ?? 0
                let pending = info["pending"] as? Int ?? 0
                self.headline.stringValue = connected ? "Mac подключён" : (self.candidates.isEmpty ? "Подключи этот Mac" : "Подключение найдено")
                let name = info["deviceName"] as? String ?? self.candidates.first?["name"] as? String ?? "Этот Mac"
                self.detail.stringValue = "\(name) · \(running > 0 ? "выполняется задач: \(running)" : "сейчас задач нет")\(pending > 0 ? " · сохраняется результатов: \(pending)" : "")\n\(connected ? "Можно выбирать этот компьютер в Team Room." : "Для работы можно также выбрать другой включённый компьютер.")"
                if let current = info["current"] as? [String: Any], let version = current["connectorVersion"] as? String {
                    self.detail.stringValue += "\nПодключение: \(version)"
                }
                if let current = info["current"] as? [String: Any], let storage = current["storage"] as? [String: Any] {
                    if storage["external"] as? Bool == true {
                        let disk = URL(fileURLWithPath: storage["volumePath"] as? String ?? "").lastPathComponent
                        self.detail.stringValue += "\nРабочие файлы: внешний диск \(disk)"
                        if storage["available"] as? Bool == false { self.notice.stringValue = current["storageError"] as? String ?? "Подключи выбранный внешний диск." }
                    } else { self.detail.stringValue += "\nРабочие файлы: внутренний диск" }
                }
                if let migration = info["storageMigration"] as? [String: Any], let message = migration["message"] as? String { self.notice.stringValue = message }
                else if let update = info["connectorUpdate"] as? [String: Any], let message = update["message"] as? String {
                    self.notice.stringValue = message
                }
            }
        }
    }
    @objc private func setupDevice() {
        guard !pairing, let room = roomWindow else { return }
        room.sessionToken { [weak self] session in
            guard let self else { return }
            guard let session else { self.notice.stringValue = "Сначала войди в Team Room в главном окне приложения."; room.open(); return }
            let alert = NSAlert(); alert.messageText = "Подключить этот Mac"
            alert.informativeText = "Укажи имя, по которому будешь узнавать этот компьютер. Приложение зарегистрирует Mac и настроит работу в фоне."
            let field = NSTextField(string: Host.current().localizedName ?? "Мой Mac"); field.placeholderString = "Например, Рабочий Mac"; field.frame = NSRect(x: 0, y: 0, width: 340, height: 28); alert.accessoryView = field
            alert.addButton(withTitle: "Подключить"); alert.addButton(withTitle: "Отмена")
            alert.beginSheetModal(for: self.window!) { [weak self] answer in
                guard answer == .alertFirstButtonReturn, let self else { return }
                let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty, name.count <= 80 else { self.notice.stringValue = "Введи имя Mac до 80 символов."; return }
                self.pairing = true; self.notice.stringValue = "Подключаю Mac…"
                self.helper.request("pair", ["name": name, "session": session]) { [weak self] result in
                    guard let self else { return }; self.pairing = false; self.finish(result); room.reconnect()
                    if case .success = result { self.notice.stringValue = "Подключение настроено. Войди в Claude и Codex кнопками ниже, если подписки ещё не подключены." }
                }
            }
        }
    }
    @objc private func importArchive() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.zip]; panel.allowsMultipleSelection = false; panel.canChooseDirectories = false; panel.title = "Архив подключения Team Room"
        panel.beginSheetModal(for: window!) { [weak self] result in if result == .OK, let url = panel.url { self?.confirmImport(url) } }
    }
    func confirmImport(_ url: URL) {
        let alert = NSAlert(); alert.messageText = "Подключить этот Mac к Team Room?"
        alert.informativeText = "Приложение использует архив подключения и включит работу компьютера в фоне. Входы по подписке выполняются отдельно. Уже работающие задачи не будут остановлены."
        alert.addButton(withTitle: "Подключить"); alert.addButton(withTitle: "Отмена")
        let parent = window?.isVisible == true ? window : NSApp.mainWindow
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] answer in
            guard answer == .alertFirstButtonReturn, let self else { return }
            self.present(); self.notice.stringValue = "Настраиваю фоновое подключение…"
            self.helper.request("importZip", ["path": url.path]) { [weak self] result in
                guard let self else { return }
                if case .success(let info) = result, let connection = info["connection"] as? [String: Any], let id = connection["id"] as? String {
                    self.helper.request("install", ["id": id]) { [weak self] result in self?.finish(result) }
                } else { self.finish(result) }
            }
        }
        if let parent { alert.beginSheetModal(for: parent, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }
    @objc private func startExisting() {
        guard let id = candidates[safe: chooser.indexOfSelectedItem]?["id"] as? String ?? candidates.first?["id"] as? String else { notice.stringValue = "Сначала подключи этот Mac или открой архив подключения."; return }
        notice.stringValue = "Проверяю фоновое подключение…"
        let selected = candidates.first { $0["id"] as? String == id }; let action = selected?["installed"] as? Bool == true ? "start" : "install"
        helper.request(action, ["id": id]) { [weak self] result in self?.finish(result) }
    }
    @objc private func updateImport() {
        guard let id = candidates[safe: chooser.indexOfSelectedItem]?["id"] as? String ?? candidates.first?["id"] as? String else { notice.stringValue = "Сначала подключи этот Mac."; return }
        notice.stringValue = "Проверяю, что Mac свободен, и обновляю перенос…"
        helper.request("updateImport", ["id": id]) { [weak self] result in self?.finish(result) }
    }
    @objc private func moveStorage() {
        guard let id = candidates[safe: chooser.indexOfSelectedItem]?["id"] as? String ?? candidates.first?["id"] as? String else { notice.stringValue = "Сначала подключи этот Mac."; return }
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.title = "Внешний диск для рабочих файлов Team Room"; panel.message = "Выбери внешний диск. Team Room перенесёт туда рабочие папки, архивы и временные передачи с проверкой файлов."
        panel.prompt = "Перенести"; panel.directoryURL = URL(fileURLWithPath: "/Volumes")
        panel.beginSheetModal(for: window!) { [weak self] result in
            guard result == .OK, let self, let url = panel.url else { return }
            let granted = url.startAccessingSecurityScopedResource(); self.notice.stringValue = "Проверяю внешний диск и сохранение текущей работы…"
            self.helper.request("migrateStorage", ["id": id, "volumePath": url.path]) { [weak self] answer in
                if granted { url.stopAccessingSecurityScopedResource() }; self?.finish(answer)
            }
        }
    }
    @objc private func loginClaude() { login("claude") }
    @objc private func loginCodex() { login("codex") }
    private func login(_ provider: String) {
        notice.stringValue = "Откроется официальный вход. Используй существующую подписку."
        helper.request("login", ["provider": provider]) { [weak self] result in self?.finish(result) }
    }
    private func finish(_ result: Result<[String: Any], Error>) {
        switch result {
        case .success(let info): notice.stringValue = info["message"] as? String ?? "Готово. Состояние подключения обновляется."; refresh()
        case .failure(let error): notice.stringValue = error.localizedDescription
        }
    }
    func receiveEvent(_ packet: [String: Any]) {
        let name = packet["event"] as? String ?? ""
        if name == "auth-url" || name == "login-url", let value = packet["url"] as? String, let url = URL(string: value), url.scheme == "https", let host = url.host?.lowercased(), ["claude.ai", "console.anthropic.com", "auth.openai.com", "auth0.openai.com", "chatgpt.com", "openai.com", "platform.claude.com", "platform.openai.com", "login.openai.com"].contains(host), url.user == nil && url.password == nil { NSWorkspace.shared.open(url) }
        if let message = packet["message"] as? String { notice.stringValue = String(message.prefix(450)) }
        if name == "storage-migration" && packet["state"] as? String == "completed" { refresh() }
        if name == "login-complete" || name == "installed" || (name == "connector-update" && packet["state"] as? String == "updated") { refresh() }
    }
}
private extension Array { subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil } }

@MainActor
final class DownloadRecord {
    let destination: URL
    let staging: URL
    let directory: URL
    let connectionArchive: Bool
    init(destination: URL, staging: URL, directory: URL, connectionArchive: Bool) { self.destination = destination; self.staging = staging; self.directory = directory; self.connectionArchive = connectionArchive }
}

@MainActor
final class RoomWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    private let mainRoom: Bool
    private let progress = NSProgressIndicator()
    private let loadingLabel = NSTextField(labelWithString: "Открываю Team Room…")
    private let errorView = NSStackView()
    private let errorMessage = NSTextField(wrappingLabelWithString: "")
    private var downloads: [ObjectIdentifier: DownloadRecord] = [:]
    private var children: [RoomWindow] = []
    var showComputer: (() -> Void)?
    var importConnection: ((URL) -> Void)?
    var onClose: (() -> Void)?
    var requestLocalDevice: (() -> Void)?
    private var localDeviceId: String?
    private var localDeviceResolved = false
    private var hasDocument = false
    private var observedLoading: NSKeyValueObservation?

    init(main: Bool = true, configuration supplied: WKWebViewConfiguration? = nil) {
        mainRoom = main
        let configuration = supplied ?? WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = WKUserContentController()
        if main { configuration.userContentController.addUserScript(WKUserScript(source: "if(location.origin==='\(roomURL.scheme!)://\(roomURL.host!)\(roomURL.port.map { ":\($0)" } ?? "")'&&['/','/room','/room/'].includes(location.pathname)){window.teamRoomNativeMac=true;window.teamRoomLocalDeviceId=null;window.teamRoomLocalDeviceReady=false}", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: main ? 1260 : 1060, height: main ? 820 : 750), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = main ? "Team Room Community" : "Просмотр файла — Team Room"
        window.minSize = NSSize(width: 690, height: 500)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = brandBackground
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        window.setFrameAutosaveName(main ? "TeamRoomMainWindow" : "TeamRoomFileWindow")
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(webView)
        NSLayoutConstraint.activate([webView.leadingAnchor.constraint(equalTo: content.leadingAnchor), webView.trailingAnchor.constraint(equalTo: content.trailingAnchor), webView.topAnchor.constraint(equalTo: content.safeAreaLayoutGuide.topAnchor), webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)])
        progress.style = .spinning; progress.controlSize = .small
        loadingLabel.textColor = .secondaryLabelColor; loadingLabel.font = .systemFont(ofSize: 12)
        let loading = NSStackView(views: [progress, loadingLabel]); loading.spacing = 8; loading.orientation = .horizontal; loading.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(loading)
        NSLayoutConstraint.activate([loading.centerXAnchor.constraint(equalTo: content.centerXAnchor), loading.centerYAnchor.constraint(equalTo: content.centerYAnchor)])
        errorMessage.textColor = .secondaryLabelColor; errorMessage.font = .systemFont(ofSize: 14)
        let errorTitle = NSTextField(labelWithString: "Не удалось открыть Team Room"); errorTitle.font = .systemFont(ofSize: 22, weight: .semibold)
        let retry = NSButton(title: "Попробовать снова", target: self, action: #selector(reload))
        errorView.addArrangedSubview(errorTitle); errorView.addArrangedSubview(errorMessage); errorView.addArrangedSubview(retry)
        errorView.orientation = .vertical; errorView.alignment = .centerX; errorView.spacing = 14; errorView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(errorView)
        NSLayoutConstraint.activate([errorView.centerXAnchor.constraint(equalTo: content.centerXAnchor), errorView.centerYAnchor.constraint(equalTo: content.centerYAnchor), errorView.widthAnchor.constraint(lessThanOrEqualToConstant: 480)])
        errorView.isHidden = true
        observedLoading = webView.observe(\.isLoading, options: [.new]) { [weak self, weak loading] _, _ in Task { @MainActor in guard let self else { return }; loading?.isHidden = !self.webView.isLoading || self.hasDocument; if self.webView.isLoading { self.progress.startAnimation(nil) } else { self.progress.stopAnimation(nil) } } }
        let accessory = NSTitlebarAccessoryViewController()
        let action = NSButton(title: main ? "Этот Mac" : "Сохранить файл", target: self, action: main ? #selector(openComputer) : #selector(saveCurrentFile))
        action.bezelStyle = .texturedRounded; action.controlSize = .small
        action.sizeToFit(); accessory.view = action; accessory.layoutAttribute = .right; window.addTitlebarAccessoryViewController(accessory)
    }
    required init?(coder: NSCoder) { fatalError("Unavailable") }
    func open() {
        if webView.url == nil {
            webView.load(URLRequest(url: roomURL))
        }
        showWindow(nil); window?.makeKeyAndOrderFront(nil)
    }
    @objc func reload() { errorView.isHidden = true; if let url = webView.url { webView.load(URLRequest(url: url)) } else { webView.load(URLRequest(url: roomURL)) } }
    @objc private func openComputer() { showComputer?() }
    @objc func saveCurrentFile() { if let url = webView.url, trusted(url) { let request = URLRequest(url: url); webView.startDownload(using: request) { [weak self] download in download.delegate = self } } }
    func fixedScript(_ script: String) { if applicationPage(webView.url) { webView.evaluateJavaScript(script, completionHandler: nil) } }
    func updateLocalDevice(_ info: [String: Any]) {
        guard mainRoom else { return }
        let candidate = (info["current"] as? [String: Any])?["deviceId"] as? String
        localDeviceResolved = true
        localDeviceId = candidate.flatMap { $0.range(of: "^[A-Za-z0-9-]{16,80}$", options: .regularExpression) == nil ? nil : $0 }
        publishLocalDevice()
    }
    private func publishLocalDevice() {
        guard mainRoom, applicationPage(webView.url) else { return }
        // Share only the public device identity. Pairing tokens and file paths stay native.
        let payload: [String: Any] = ["deviceId": localDeviceId.map { $0 as Any } ?? NSNull()]
        guard let bytes = try? JSONSerialization.data(withJSONObject: payload), let encoded = String(data: bytes, encoding: .utf8) else { return }
        fixedScript("window.teamRoomNativeMac=true;window.teamRoomLocalDeviceReady=\(localDeviceResolved ? "true" : "false");window.teamRoomLocalDeviceId=\(encoded).deviceId;window.dispatchEvent(new CustomEvent('teamroom:local-device',{detail:\(encoded)}));")
    }
    func reconnect() { fixedScript("window.dispatchEvent(new Event('online'));") }
    func sessionToken(_ completion: @escaping (String?) -> Void) {
        guard mainRoom, applicationPage(webView.url) else { completion(nil); return }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            Task { @MainActor in
                guard let self, applicationPage(self.webView.url) else { completion(nil); return }
                let cookie = cookies.first { $0.name == "trc_session" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == roomURL.host && $0.path == "/" && $0.isSecure && ($0.expiresDate ?? .distantFuture) > Date() }
                completion(cookie?.value)
            }
        }
    }
    func setupComputer() { open(); fixedScript("if(typeof window.showDevices==='function'){window.showDevices()}else{alert('Сначала войди в Team Room, затем открой «Компьютеры».')}") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasDocument = true; errorView.isHidden = true
        if mainRoom { publishLocalDevice(); requestLocalDevice?() }
    }
    private func navigationError(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        errorMessage.stringValue = "Проверь интернет и попробуй ещё раз. Чаты и файлы остаются в общем пространстве.\n\n\(error.localizedDescription)"
        errorView.isHidden = false; progress.stopAnimation(nil)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { errorMessage.stringValue = "Окно приложения было выгружено системой. Нажми «Попробовать снова» — сохранённая сессия восстановится. Выполнение на компьютерах продолжается."; errorView.isHidden = false }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(trusted(url) || url.scheme == "blob" ? .download : .cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(url.scheme == "file" || url.scheme == "javascript" ? .cancel : .allow); return }
        if trusted(url) || url.absoluteString == "about:blank" || url.scheme == "blob" { decisionHandler(.allow); return }
        if safeExternal(url), action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url else { return nil }
        if trusted(url) || url.absoluteString == "about:blank" || url.scheme == "blob" {
            configuration.userContentController = WKUserContentController()
            let child = RoomWindow(main: false, configuration: configuration)
            child.importConnection = importConnection
            child.onClose = { [weak self, weak child] in if let child { self?.children.removeAll { $0 === child } } }
            children.append(child); child.window?.center(); child.showWindow(nil); child.window?.makeKeyAndOrderFront(nil)
            return child.webView
        }
        if safeExternal(url) { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard mainRoom, applicationPage(webView.url), frame.isMainFrame else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = !parameters.allowsDirectories
        panel.prompt = parameters.allowsDirectories ? "Добавить папку" : "Добавить"
        panel.beginSheetModal(for: window!) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "Team Room Community"; alert.informativeText = String(message.prefix(4000)); alert.addButton(withTitle: "ОК")
        alert.beginSheetModal(for: window!) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Team Room Community"; alert.informativeText = String(message.prefix(4000)); alert.addButton(withTitle: "Продолжить"); alert.addButton(withTitle: "Отмена")
        alert.beginSheetModal(for: window!) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "Team Room Community"; alert.informativeText = String(prompt.prefix(4000)); alert.addButton(withTitle: "Сохранить"); alert.addButton(withTitle: "Отмена")
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 300, height: 25); alert.accessoryView = field
        alert.beginSheetModal(for: window!) { result in completionHandler(result == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let filename = (suggestedFilename as NSString).lastPathComponent.replacingOccurrences(of: "\0", with: "")
        let panel = NSSavePanel(); panel.nameFieldStringValue = filename.isEmpty ? "Team Room файл" : filename; panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window!) { [weak self] answer in
            guard let self, answer == .OK, let destination = panel.url else { completionHandler(nil); return }
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("teamroom-download-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let staging = directory.appendingPathComponent("file")
                let archive = self.mainRoom && applicationPage(self.webView.url) && filename == "Team-Room-Connect.zip" && (trusted(response.url) || response.url?.scheme == "blob")
                self.downloads[ObjectIdentifier(download)] = DownloadRecord(destination: destination, staging: staging, directory: directory, connectionArchive: archive)
                completionHandler(staging)
            } catch { self.alert("Не удалось сохранить файл", error.localizedDescription); completionHandler(nil) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let item = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        defer { try? FileManager.default.removeItem(at: item.directory) }
        do {
            if FileManager.default.fileExists(atPath: item.destination.path) { _ = try FileManager.default.replaceItemAt(item.destination, withItemAt: item.staging) }
            else { try FileManager.default.moveItem(at: item.staging, to: item.destination) }
            if item.connectionArchive { importConnection?(item.destination) }
            else { NSWorkspace.shared.activateFileViewerSelecting([item.destination]) }
        } catch { alert("Не удалось завершить сохранение", error.localizedDescription) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let item = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: item.directory) }
        if (error as NSError).code != NSURLErrorCancelled { alert("Файл не загрузился", error.localizedDescription) }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) { decisionHandler(trusted(request.url) ? .allow : .cancel) }
    private func alert(_ title: String, _ text: String) { let alert = NSAlert(); alert.messageText = title; alert.informativeText = text; alert.addButton(withTitle: "ОК"); alert.beginSheetModal(for: window!, completionHandler: nil) }
    func windowWillClose(_ notification: Notification) { if !mainRoom { webView.stopLoading(); onClose?() } }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var room: RoomWindow!
    private var helper: NativeHelper!
    private var computer: ComputerController!
    private var updates: UpdateController!
    private var wake: NSObjectProtocol?
    private var localDeviceTimer: Timer?
    private var localDeviceReading = false
    private var releaseTimer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        guard let hub = selectCommunityHub() else { NSApp.terminate(nil); return }; roomURL = hub
        helper = NativeHelper(); room = RoomWindow(); computer = ComputerController(helper: helper); updates = UpdateController(helper: helper)
        room.showComputer = { [weak self] in self?.computer.present() }
        room.requestLocalDevice = { [weak self] in self?.refreshLocalDevice() }
        room.importConnection = { [weak self] url in self?.computer.confirmImport(url) }
        computer.roomWindow = room
        helper.event = { [weak self] packet in self?.computer.receiveEvent(packet); self?.updates.receiveEvent(packet); if ["installed", "login-complete", "connector-update"].contains(packet["event"] as? String ?? "") { self?.refreshLocalDevice() } }
        buildMenu(); room.window?.center(); room.open()
        refreshLocalDevice()
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in self?.checkReleaseNotice() }
        releaseTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in Task { @MainActor in self?.checkReleaseNotice() } }
        localDeviceTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.refreshLocalDevice() } }
        NSApp.activate(ignoringOtherApps: true)
        wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.room.reconnect(); self?.refreshLocalDevice() } }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { room?.open(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillBecomeActive(_ notification: Notification) { room?.reconnect(); refreshLocalDevice() }
    func applicationWillTerminate(_ notification: Notification) { localDeviceTimer?.invalidate(); releaseTimer?.invalidate(); helper?.close(); if let wake { NSWorkspace.shared.notificationCenter.removeObserver(wake) } }
    private func refreshLocalDevice() {
        guard helper != nil, room != nil, !localDeviceReading else { return }
        localDeviceReading = true
        helper.request("status", timeout: 20) { [weak self] result in
            guard let self else { return }; self.localDeviceReading = false
            if case .success(let info) = result { self.room.updateLocalDevice(info) }
        }
    }
    private func buildMenu() {
        let menu = NSMenu()
        let app = NSMenu(title: "Team Room Community")
        app.addItem(withTitle: "О Team Room", action: #selector(about), keyEquivalent: "")
        app.addItem(.separator()); app.addItem(withTitle: "Этот Mac…", action: #selector(showComputer), keyEquivalent: ",")
        app.addItem(withTitle: "Проверить обновления…", action: #selector(showUpdates), keyEquivalent: "")
        let autoUpdates = app.addItem(withTitle: "Проверять обновления автоматически", action: #selector(toggleReleaseChecks), keyEquivalent: ""); autoUpdates.state = UserDefaults.standard.object(forKey: "communityReleaseChecks") as? Bool == false ? .off : .on
        app.addItem(.separator()); app.addItem(withTitle: "Скрыть Team Room", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Скрыть остальные", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h"); hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Показать все", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator()); app.addItem(withTitle: "Завершить Team Room", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        add(menu, title: "Team Room Community", submenu: app)
        let file = NSMenu(title: "Файл")
        file.addItem(withTitle: "Новый чат", action: #selector(newChat), keyEquivalent: "n")
        file.addItem(withTitle: "Этот Mac…", action: #selector(showComputer), keyEquivalent: "k").keyEquivalentModifierMask = [.command, .shift]
        file.addItem(withTitle: "Закрыть окно", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        add(menu, title: "Файл", submenu: file)
        let edit = NSMenu(title: "Правка")
        for (title, selector, key) in [("Отменить", Selector(("undo:")), "z"), ("Повторить", Selector(("redo:")), "Z"), ("Вырезать", #selector(NSText.cut(_:)), "x"), ("Копировать", #selector(NSText.copy(_:)), "c"), ("Вставить", #selector(NSText.paste(_:)), "v"), ("Выбрать всё", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
        add(menu, title: "Правка", submenu: edit)
        let view = NSMenu(title: "Вид")
        view.addItem(withTitle: "Обновить страницу", action: #selector(refresh), keyEquivalent: "r")
        view.addItem(withTitle: "Увеличить", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Уменьшить", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(withTitle: "Исходный масштаб", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(withTitle: "На весь экран", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        add(menu, title: "Вид", submenu: view)
        let window = NSMenu(title: "Окно"); window.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"); window.addItem(withTitle: "Показать Team Room", action: #selector(showRoom), keyEquivalent: "1"); add(menu, title: "Окно", submenu: window); NSApp.windowsMenu = window
        let help = NSMenu(title: "Помощь"); help.addItem(withTitle: "Как пользоваться", action: #selector(showHelp), keyEquivalent: ""); add(menu, title: "Помощь", submenu: help)
        NSApp.mainMenu = menu
        for submenu in [app, file, view, help] { for item in submenu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) && item.action != #selector(NSWindow.performClose(_:)) && item.action != #selector(NSWindow.toggleFullScreen(_:)) { if responds(to: item.action!) { item.target = self } } }
    }
    private func add(_ menu: NSMenu, title: String, submenu: NSMenu) { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.submenu = submenu; menu.addItem(item) }
    @objc private func toggleReleaseChecks() {
        let enabled = !(UserDefaults.standard.object(forKey: "communityReleaseChecks") as? Bool ?? true)
        UserDefaults.standard.set(enabled, forKey: "communityReleaseChecks")
        NSApp.mainMenu?.items.first?.submenu?.items.first { $0.action == #selector(toggleReleaseChecks) }?.state = enabled ? .on : .off
        if enabled { checkReleaseNotice() }
    }
    private func checkReleaseNotice() {
        guard helper != nil, UserDefaults.standard.object(forKey: "communityReleaseChecks") as? Bool != false else { return }
        helper.request("updateStatus", timeout: 35) { result in
            if case .success(let info) = result, info["available"] as? Bool == true {
                NSApp.mainMenu?.items.first?.submenu?.items.first { $0.action == #selector(self.showUpdates) }?.title = "Доступно обновление " + (info["version"] as? String ?? "") + "…"
            }
        }
    }
    @objc private func showUpdates() { updates.present() }
    @objc private func showRoom() { room.open() }
    @objc private func showComputer() { computer.present() }
    private var activeRoom: RoomWindow { (NSApp.keyWindow?.windowController as? RoomWindow) ?? room }
    @objc private func refresh() { activeRoom.reload() }
    @objc private func newChat() { room.open(); room.fixedScript("if(typeof window.newChat==='function'){window.newChat()}") }
    @objc private func zoomIn() { activeRoom.webView.pageZoom = min(1.8, activeRoom.webView.pageZoom + 0.1) }
    @objc private func zoomOut() { activeRoom.webView.pageZoom = max(0.7, activeRoom.webView.pageZoom - 0.1) }
    @objc private func zoomReset() { activeRoom.webView.pageZoom = 1 }
    @objc private func about() {
        let alert = NSAlert(); alert.messageText = "Team Room для Mac"; alert.informativeText = "Общее рабочее пространство для Claude Code и Codex.\nВерсия \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")\n\nЧаты, память, файлы, MCP и скиллы используют тот же Team Room, что и сайт. Рабочие запросы выполняются выбранным компьютером по твоей подписке."; alert.addButton(withTitle: "ОК"); alert.runModal()
    }
    @objc private func showHelp() {
        let alert = NSAlert(); alert.messageText = "Начни с существующего аккаунта"; alert.informativeText = "1. Войди в Team Room: первый вход в приложении подтверждается через Telegram.\n2. Выбери проект и чат — они общие с сайтом.\n3. Выбери Claude или Codex и компьютер для работы.\n4. Файлы можно прикреплять, перетаскивать или вставлять из буфера.\n\nЕсли этот Mac уже подключён, повторное подключение не нужно. Для нового Mac нажми «Этот Mac». Закрытие окна приложения не останавливает фоновую работу."; alert.addButton(withTitle: "Понятно"); alert.runModal()
    }
}

@main
struct TeamRoomApp {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
