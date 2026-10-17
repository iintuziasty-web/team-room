import UIKit
import WebKit
import PhotosUI
import UniformTypeIdentifiers
import Network

private enum Room {
    static let home = URL(string: Bundle.main.object(forInfoDictionaryKey: "TeamRoomHubURL") as! String)!
    static let userAgentMarker = "TeamRoom-iOS/1.0"
    static let background = UIColor(red: 0.082, green: 0.082, blue: 0.082, alpha: 1)
    static let accent = UIColor(red: 0.843, green: 0.467, blue: 0.341, alpha: 1)

    static func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == home.scheme && url.host?.lowercased() == home.host
            && url.port == home.port && url.user == nil && url.password == nil
    }
    static func page(_ url: URL?) -> Bool { trusted(url) && url?.path == "/" }
    static func blob(_ url: URL?) -> Bool {
        guard let url, url.scheme == "blob" else { return false }
        return trusted(URL(string: String(url.absoluteString.dropFirst(5))))
    }
    static func external(_ url: URL) -> Bool {
        ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "")
            && url.user == nil && url.password == nil
    }
    static func file(_ url: URL?) -> Bool {
        guard trusted(url), let url else { return false }
        return url.path.hasPrefix("/api/projects/") && url.path.hasSuffix("/files")
    }
}

/// Only explicitly selected uploads and downloads enter this private cache.
/// No credentials, project histories or computer registrations are copied here.
private enum FileStaging {
    static var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TeamRoomTransfers", isDirectory: true)
    }
    static func directory() throws -> URL {
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var excluded = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        return directory
    }
    static func filename(_ suggested: String) -> String {
        let base = (suggested as NSString).lastPathComponent
        let clean = base.replacingOccurrences(of: "\0", with: "")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean != ".", clean != ".." else { return "Team Room файл" }
        var ext = String(((clean as NSString).pathExtension).prefix(20))
        var name = String(((clean as NSString).deletingPathExtension).prefix(120))
        while ext.utf8.count > 40 { ext.removeLast() }
        while name.utf8.count > 180 { name.removeLast() }
        return ext.isEmpty ? name : name + "." + ext
    }
    static func copy(_ selected: URL, to directory: URL, suggested: String? = nil) throws -> URL {
        let scoped = selected.startAccessingSecurityScopedResource()
        defer { if scoped { selected.stopAccessingSecurityScopedResource() } }
        if try selected.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
            throw NSError(domain: "TeamRoom", code: 2, userInfo: [NSLocalizedDescriptionKey: "Выбери сам файл, а не символическую ссылку."])
        }
        let basename = filename(suggested ?? selected.lastPathComponent)
        var target = directory.appendingPathComponent(basename)
        if FileManager.default.fileExists(atPath: target.path) {
            target = directory.appendingPathComponent(UUID().uuidString + "-" + basename)
        }
        try FileManager.default.copyItem(at: selected, to: target)
        // A selected directory may contain links outside it. Never grant WebKit access
        // to those targets when uploading the private copy of that directory.
        if let files = FileManager.default.enumerator(at: target, includingPropertiesForKeys: [.isSymbolicLinkKey]) {
            for case let file as URL in files {
                if try file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
                    files.skipDescendants(); try FileManager.default.removeItem(at: file)
                }
            }
        }
        return target
    }
    static func remove(_ directory: URL) { try? FileManager.default.removeItem(at: directory) }
    static func cleanPreviousLaunches() {
        // The old process no longer has a picker or WebKit upload reading these files.
        guard let directories = try? FileManager.default.contentsOfDirectory(at: root,
            includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles]) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        for directory in directories {
            if let created = try? directory.resourceValues(forKeys: [.creationDateKey]).creationDate,
               created < cutoff { remove(directory) }
        }
    }
}

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UIView.appearance().tintColor = Room.accent
        FileStaging.cleanPreviousLaunches()
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Team Room Community", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var room: RoomViewController?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let controller = RoomViewController()
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.backgroundColor = Room.background
        window.rootViewController = controller
        self.room = controller; self.window = window
        window.makeKeyAndVisible()
    }
    func sceneDidBecomeActive(_ scene: UIScene) { room?.resume() }
    func sceneDidEnterBackground(_ scene: UIScene) {
        // Inference continues on the selected Mac. Never stop it or reload the chat here.
        room?.enteredBackground()
    }
}

private struct DownloadRecord: Sendable {
    let directory: URL
    let file: URL
    init(directory: URL, file: URL) { self.directory = directory; self.file = file }
}

@MainActor
final class RoomViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
                                WKDownloadDelegate, UIDocumentPickerDelegate, PHPickerViewControllerDelegate,
                                UIAdaptivePresentationControllerDelegate, UIPopoverPresentationControllerDelegate {
    let webView: WKWebView
    private let mainRoom: Bool
    private let initialURL: URL?
    private let loading = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let loadingLabel = UILabel()
    private let errorPanel = UIStackView()
    private let errorLabel = UILabel()
    private let banner = UIStackView()
    private let bannerLabel = UILabel()
    private var loadingObservation: NSKeyValueObservation?
    private var hasDocument = false
    private var contentTerminated = false
    private var pathMonitor: NWPathMonitor?
    private var online = true
    private var previewChildren: [RoomViewController] = []
    private var downloads: [ObjectIdentifier: DownloadRecord] = [:]
    private var activeDownloads: [ObjectIdentifier: WKDownload] = [:]
    private var pendingShares: [DownloadRecord] = []
    private var shareInProgress = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var uploadCompletion: (([URL]?) -> Void)?
    private var uploadMultiple = false
    private var uploadDirectories: [URL] = []
    private weak var previewNavigation: UINavigationController?
    private var previewSave: UIBarButtonItem?
    private var onClose: (() -> Void)?

    init(main: Bool = true, configuration supplied: WKWebViewConfiguration? = nil, initialURL: URL? = nil) {
        mainRoom = main; self.initialURL = initialURL
        let configuration = supplied ?? WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = WKUserContentController()
        configuration.applicationNameForUserAgent = Room.userAgentMarker
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = [.audio, .video]
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.isInspectable = false
        webView.allowsBackForwardNavigationGestures = !main
        webView.isOpaque = false; webView.backgroundColor = Room.background
        webView.scrollView.backgroundColor = Room.background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
    }
    required init?(coder: NSCoder) { fatalError("Unavailable") }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Room.background
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // The shared UI owns viewport-fit, safe-area insets and visualViewport keyboard sizing.
        // A second UIKit keyboard inset would move the composer twice.
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: mainRoom ? view.topAnchor : view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: mainRoom ? view.bottomAnchor : view.safeAreaLayoutGuide.bottomAnchor)
        ])
        configureLoadingAndErrors()
        if !mainRoom {
            title = "Просмотр файла"
            navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Закрыть", style: .plain, target: self, action: #selector(closePreview))
            let save = UIBarButtonItem(title: "Сохранить", style: .plain, target: self, action: #selector(savePreview))
            save.isEnabled = false; previewSave = save; navigationItem.rightBarButtonItem = save
        }
        loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.loading.isHidden = self.hasDocument || !self.webView.isLoading
                if self.webView.isLoading { self.spinner.startAnimating() } else { self.spinner.stopAnimating() }
            }
        }
        if mainRoom {
            let monitor = NWPathMonitor(); pathMonitor = monitor
            monitor.pathUpdateHandler = { [weak self] path in
                let available = path.status == .satisfied
                Task { @MainActor in self?.networkChanged(available) }
            }
            monitor.start(queue: DispatchQueue(label: "io.teamroom.community.ios.network"))
            // Always begin at the fixed hub page. It restores the last chat for this account.
            webView.load(URLRequest(url: Room.home))
        } else if let initialURL { webView.load(URLRequest(url: initialURL)) }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        showNextShare()
    }
    private func configureLoadingAndErrors() {
        loadingLabel.text = "Открываю Team Room…"; loadingLabel.font = .systemFont(ofSize: 14)
        loadingLabel.textColor = .secondaryLabel
        loading.axis = .horizontal; loading.alignment = .center; loading.spacing = 10
        loading.addArrangedSubview(spinner); loading.addArrangedSubview(loadingLabel)
        loading.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(loading)
        NSLayoutConstraint.activate([loading.centerXAnchor.constraint(equalTo: view.centerXAnchor), loading.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        spinner.startAnimating()
        let title = UILabel(); title.text = "Team Room пока недоступен"; title.numberOfLines = 0
        title.font = .systemFont(ofSize: 21, weight: .semibold); title.textAlignment = .center
        errorLabel.font = .systemFont(ofSize: 15); errorLabel.textColor = .secondaryLabel
        errorLabel.numberOfLines = 0; errorLabel.textAlignment = .center
        var config = UIButton.Configuration.filled(); config.title = "Попробовать снова"; config.baseBackgroundColor = Room.accent
        let retry = UIButton(configuration: config); retry.addTarget(self, action: #selector(retryLoading), for: .touchUpInside)
        errorPanel.axis = .vertical; errorPanel.alignment = .center; errorPanel.spacing = 16
        [title, errorLabel, retry].forEach(errorPanel.addArrangedSubview)
        errorPanel.translatesAutoresizingMaskIntoConstraints = false; errorPanel.isHidden = true
        view.addSubview(errorPanel)
        NSLayoutConstraint.activate([
            errorPanel.centerXAnchor.constraint(equalTo: view.centerXAnchor), errorPanel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorPanel.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            errorPanel.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 26),
            errorPanel.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -26)
        ])
        bannerLabel.font = .systemFont(ofSize: 12); bannerLabel.textColor = .label; bannerLabel.numberOfLines = 2
        let reconnect = UIButton(type: .system); reconnect.setTitle("Повторить", for: .normal)
        reconnect.titleLabel?.font = .systemFont(ofSize: 12, weight: .semibold)
        reconnect.addTarget(self, action: #selector(reconnectExistingPage), for: .touchUpInside)
        banner.axis = .horizontal; banner.spacing = 10; banner.alignment = .center
        banner.backgroundColor = UIColor.secondarySystemBackground
        banner.isLayoutMarginsRelativeArrangement = true; banner.layoutMargins = UIEdgeInsets(top: 9, left: 14, bottom: 9, right: 14)
        banner.layer.cornerRadius = 10; banner.clipsToBounds = true
        banner.addArrangedSubview(bannerLabel); banner.addArrangedSubview(reconnect)
        banner.isHidden = true; banner.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(banner)
        NSLayoutConstraint.activate([
            banner.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            banner.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -10),
            banner.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4)
        ])
    }
    private func banner(_ text: String) { bannerLabel.text = text; banner.isHidden = false }
    private func showError(_ text: String) {
        spinner.stopAnimating(); loading.isHidden = true
        errorLabel.text = text; errorPanel.isHidden = false
    }
    private func navigationError(_ error: Error) {
        let value = error as NSError
        if value.domain == NSURLErrorDomain && value.code == NSURLErrorCancelled { return }
        if hasDocument { banner("Связь прервалась. Чат и черновик остаются открытыми.") }
        else { showError("Проверь интернет и попробуй ещё раз. Работа на выбранном Mac продолжается; история и файлы сохранены в Team Room.") }
    }
    @objc private func retryLoading() {
        errorPanel.isHidden = true; banner.isHidden = true; contentTerminated = false
        let destination = mainRoom ? Room.home : (Room.file(webView.url) ? webView.url! : (initialURL ?? Room.home))
        webView.load(URLRequest(url: destination))
    }
    @objc private func reconnectExistingPage() {
        if hasDocument && !contentTerminated { resume() }
        else { retryLoading() }
    }
    private func networkChanged(_ available: Bool) {
        let changed = available != online; online = available
        if available {
            if changed { resume() }
        } else if hasDocument { banner("Нет интернета. Работа на выбранном Mac продолжается.") }
        else { showError("Сейчас нет интернета. Подключись к сети и нажми «Попробовать снова».") }
    }
    func resume() {
        guard isViewLoaded else { return }
        if online && hasDocument && !contentTerminated && mainRoom && Room.page(webView.url) {
            // Fixed, one-way lifecycle signals only. No script-message handlers or remote native commands.
            webView.evaluateJavaScript("window.dispatchEvent(new Event('online'));", completionHandler: nil)
            banner.isHidden = true
        }
        for child in previewChildren { child.showNextShare() }
        showNextShare()
    }
    func enteredBackground() {
        for child in previewChildren { child.enteredBackground() }
        guard !activeDownloads.isEmpty, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Team Room file transfer") { [weak self] in
            guard let self else { return }
            for (key, download) in Array(self.activeDownloads) {
                download.cancel { [weak self] _ in
                    guard let self else { return }
                    self.activeDownloads.removeValue(forKey: key)
                    if let record = self.downloads.removeValue(forKey: key) { FileStaging.remove(record.directory) }
                    if self.activeDownloads.isEmpty { self.previewSave?.isEnabled = Room.file(self.webView.url) }
                }
            }
            self.endBackgroundTask()
        }
    }
    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasDocument = true; contentTerminated = false; errorPanel.isHidden = true; loading.isHidden = true
        previewSave?.isEnabled = Room.file(webView.url)
        if online { banner.isHidden = true }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        contentTerminated = true; hasDocument = false
        showError("iOS выгрузила окно приложения. Нажми «Попробовать снова», чтобы восстановить сохранённый чат. Работа на компьютере продолжается.")
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let safe = Room.trusted(url) || Room.blob(url)
        if action.shouldPerformDownload { decisionHandler(safe ? .download : .cancel); return }
        if safe || url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if action.targetFrame?.isMainFrame != false && action.navigationType == .linkActivated && Room.external(url) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard Room.trusted(response.response.url) || Room.blob(response.response.url) || response.response.url?.absoluteString == "about:blank" else {
            decisionHandler(.cancel); return
        }
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true
        if attachment || !response.canShowMIMEType { decisionHandler(.download) }
        else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard action.targetFrame == nil, let url = action.request.url else { return nil }
        guard Room.file(url) || Room.blob(url) || url.absoluteString == "about:blank" else {
            if action.navigationType == .linkActivated && Room.external(url) { UIApplication.shared.open(url) }
            return nil
        }
        guard presentedViewController == nil else { return nil }
        let child = RoomViewController(main: false, configuration: configuration)
        let navigation = UINavigationController(rootViewController: child)
        navigation.modalPresentationStyle = .fullScreen
        navigation.navigationBar.standardAppearance = previewBarAppearance()
        navigation.navigationBar.scrollEdgeAppearance = previewBarAppearance()
        child.previewNavigation = navigation
        child.onClose = { [weak self, weak child] in
            if let child { self?.previewChildren.removeAll { $0 === child } }
            self?.showNextShare()
        }
        previewChildren.append(child)
        present(navigation, animated: true)
        child.loadViewIfNeeded()
        return child.webView
    }
    private func previewBarAppearance() -> UINavigationBarAppearance {
        let appearance = UINavigationBarAppearance(); appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = Room.background; appearance.titleTextAttributes = [.foregroundColor: UIColor.label]
        return appearance
    }
    @objc private func closePreview() {
        guard activeDownloads.isEmpty else {
            showMessage("Файл ещё скачивается", "Подожди завершения, затем сохрани его через системное меню."); return
        }
        webView.stopLoading()
        previewNavigation?.dismiss(animated: true) { [weak self] in self?.onClose?() }
    }
    @objc private func savePreview() {
        guard Room.file(webView.url), let url = webView.url else { return }
        webView.startDownload(using: URLRequest(url: url)) { [weak self] download in download.delegate = self }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard mainRoom, Room.page(webView.url), frame.isMainFrame, Room.page(frame.request.url),
              uploadCompletion == nil, presentedViewController == nil else { completionHandler(nil); return }
        uploadCompletion = completionHandler; uploadMultiple = parameters.allowsMultipleSelection
        if parameters.allowsDirectories { openDocuments(directories: true); return }
        let sheet = UIAlertController(title: "Добавить в чат", message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Фото или видео", style: .default) { [weak self, weak sheet] _ in
            sheet?.dismiss(animated: true) { self?.openPhotos() }
        })
        sheet.addAction(UIAlertAction(title: "Файлы", style: .default) { [weak self, weak sheet] _ in
            sheet?.dismiss(animated: true) { self?.openDocuments(directories: false) }
        })
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel) { [weak self] _ in self?.finishUpload(nil) })
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - view.safeAreaInsets.bottom - 40, width: 1, height: 1)
        sheet.popoverPresentationController?.delegate = self
        sheet.presentationController?.delegate = self
        present(sheet, animated: true)
    }
    // iOS 17–18.3 use WebKit's built-in Files/Photos picker for <input type="file">.
    // No library-wide Photos authorization is needed on either path.
    private func openDocuments(directories: Bool) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: directories ? [.folder] : [.item], asCopy: true)
        picker.allowsMultipleSelection = directories ? false : uploadMultiple
        picker.delegate = self; picker.modalPresentationStyle = .formSheet
        present(picker, animated: true)
        picker.presentationController?.delegate = self
    }
    private func openPhotos() {
        var configuration = PHPickerConfiguration()
        configuration.filter = .any(of: [.images, .videos])
        configuration.selectionLimit = uploadMultiple ? 0 : 1
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration); picker.delegate = self
        present(picker, animated: true)
        picker.presentationController?.delegate = self
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if uploadCompletion != nil { finishUpload(nil) }
        showNextShare()
    }
    func popoverPresentationControllerDidDismissPopover(_ popoverPresentationController: UIPopoverPresentationController) {
        if uploadCompletion != nil { finishUpload(nil) }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishUpload(nil) }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard !urls.isEmpty else { finishUpload(nil); return }
        Task { @MainActor [weak self] in
            do {
                let result = try await Task.detached(priority: .userInitiated) { () -> (URL, [URL]) in
                    let directory = try FileStaging.directory()
                    do { return (directory, try urls.map { try FileStaging.copy($0, to: directory) }) }
                    catch { FileStaging.remove(directory); throw error }
                }.value
                guard let self else { FileStaging.remove(result.0); return }
                self.uploadDirectories.append(result.0); self.finishUpload(result.1)
            } catch { self?.finishUpload(nil); self?.showMessage("Не удалось добавить файл", "Выбери доступный файл в «Файлах» и попробуй ещё раз.") }
        }
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else { finishUpload(nil); return }
        Task { @MainActor [weak self] in
            var directory: URL?
            do {
                let staging = try FileStaging.directory(); directory = staging
                var urls: [URL] = []
                // Export one selection at a time, without holding the video or image bytes in memory.
                for result in results { urls.append(try await Self.export(result.itemProvider, into: staging)) }
                guard let self else { FileStaging.remove(staging); return }
                self.uploadDirectories.append(staging); self.finishUpload(urls)
            } catch {
                if let directory { FileStaging.remove(directory) }
                self?.finishUpload(nil); self?.showMessage("Не удалось добавить фото или видео", "Дождись загрузки оригинала из iCloud и попробуй ещё раз. Его также можно выбрать через «Файлы».")
            }
        }
    }
    private static func export(_ provider: NSItemProvider, into directory: URL) async throws -> URL {
        let type: String
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) { type = UTType.movie.identifier }
        else if provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) { type = UTType.jpeg.identifier }
        else if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) { type = UTType.png.identifier }
        else { type = UTType.image.identifier }
        let suggestedName = provider.suggestedName
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url else { continuation.resume(throwing: NSError(domain: "TeamRoom", code: 1)); return }
                do {
                    // The provider removes its temporary URL as soon as this callback returns.
                    let proposed: String?
                    if let name = suggestedName, !name.isEmpty {
                        let ext = url.pathExtension
                        proposed = (name as NSString).pathExtension.isEmpty && !ext.isEmpty ? name + "." + ext : name
                    } else { proposed = nil }
                    continuation.resume(returning: try FileStaging.copy(url, to: directory, suggested: proposed))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    private func finishUpload(_ urls: [URL]?) {
        let completion = uploadCompletion; uploadCompletion = nil; completion?(urls)
        scheduleShare()
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Attachments use a deliberate system picker. A page never receives a live camera or microphone stream.
        decisionHandler(.deny)
    }
    private func allowDialog(_ frame: WKFrameInfo) -> Bool { mainRoom && Room.page(webView.url) && frame.isMainFrame && Room.page(frame.request.url) && presentedViewController == nil }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard allowDialog(frame) else { completionHandler(); return }
        let alert = UIAlertController(title: "Team Room Community", message: String(message.prefix(4000)), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "ОК", style: .default) { [weak self] _ in completionHandler(); self?.scheduleShare() }); present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard allowDialog(frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: "Team Room Community", message: String(message.prefix(4000)), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { [weak self] _ in completionHandler(false); self?.scheduleShare() })
        alert.addAction(UIAlertAction(title: "Продолжить", style: .default) { [weak self] _ in completionHandler(true); self?.scheduleShare() }); present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard allowDialog(frame) else { completionHandler(nil); return }
        let alert = UIAlertController(title: "Team Room Community", message: String(prompt.prefix(4000)), preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText; field.autocapitalizationType = .sentences }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { [weak self] _ in completionHandler(nil); self?.scheduleShare() })
        alert.addAction(UIAlertAction(title: "Сохранить", style: .default) { [weak self, weak alert] _ in completionHandler(alert?.textFields?.first?.text); self?.scheduleShare() })
        present(alert, animated: true)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard Room.trusted(response.url) || Room.blob(response.url) else { completionHandler(nil); return }
        do {
            let directory = try FileStaging.directory()
            let file = directory.appendingPathComponent(FileStaging.filename(suggestedFilename))
            let key = ObjectIdentifier(download)
            downloads[key] = DownloadRecord(directory: directory, file: file); activeDownloads[key] = download
            banner("Скачиваю файл… Он откроется в меню сохранения.")
            previewSave?.isEnabled = false
            completionHandler(file)
        } catch { completionHandler(nil); showMessage("Не удалось скачать файл", "Проверь свободное место на iPhone и попробуй ещё раз.") }
    }
    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download); activeDownloads.removeValue(forKey: key)
        if activeDownloads.isEmpty { endBackgroundTask(); banner.isHidden = true; previewSave?.isEnabled = Room.file(webView.url) }
        guard let record = downloads.removeValue(forKey: key) else { return }
        pendingShares.append(record); showNextShare()
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download); activeDownloads.removeValue(forKey: key)
        if let record = downloads.removeValue(forKey: key) { FileStaging.remove(record.directory) }
        if activeDownloads.isEmpty { endBackgroundTask(); banner.isHidden = true; previewSave?.isEnabled = Room.file(webView.url) }
        let value = error as NSError
        if value.domain != NSURLErrorDomain || value.code != NSURLErrorCancelled {
            showMessage("Файл не скачался", "Проверь интернет и свободное место, затем попробуй ещё раз.")
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(Room.trusted(request.url) ? .allow : .cancel)
    }
    private func showNextShare() {
        guard !shareInProgress, !pendingShares.isEmpty, isViewLoaded, view.window != nil,
              view.window?.windowScene?.activationState == .foregroundActive, presentedViewController == nil,
              uploadCompletion == nil else { return }
        let record = pendingShares.removeFirst(); shareInProgress = true
        let activity = UIActivityViewController(activityItems: [record.file], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = view
        activity.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        activity.completionWithItemsHandler = { [weak self] _, _, _, _ in
            FileStaging.remove(record.directory)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.shareInProgress = false
                DispatchQueue.main.async { [weak self] in self?.showNextShare() }
            }
        }
        present(activity, animated: true)
    }
    private func scheduleShare() {
        // UIKit finishes the previous picker/alert's dismissal before presenting the file sheet.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.showNextShare() }
    }
    private func showMessage(_ title: String, _ text: String) {
        guard isViewLoaded, view.window?.windowScene?.activationState == .foregroundActive, presentedViewController == nil else {
            if isViewLoaded { banner(text) }; return
        }
        let alert = UIAlertController(title: title, message: text, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "ОК", style: .default) { [weak self] _ in self?.showNextShare() })
        present(alert, animated: true)
    }
    deinit { pathMonitor?.cancel() }
}
