import Cocoa

struct Snapshot: Codable {
    let ok: Bool?
    let error: String?
    let updatedAt: String?
    let plan: PlanInfo?
    let groups: [GroupInfo]?
    let pools: [PoolInfo]?
}

struct PlanInfo: Codable {
    let tier: String?
    let promptCredits: Double?
    let flowCredits: Double?
}

struct GroupInfo: Codable {
    let id: String?
    let name: String?
    let buckets: [BucketInfo]?
}

struct BucketInfo: Codable {
    let id: String?
    let window: String?
    let label: String?
    let shortLabel: String?
    let remainingFraction: Double?
    let percent: Double?
    let resetTime: String?
    let untouched: Bool?
}

struct PoolInfo: Codable {
    let id: String?
    let name: String?
    let subtitle: String?
    let remainingFraction: Double?
    let percent: Double?
    let resetTime: String?
    let untouched: Bool?
    let modelCount: Int?
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let snapshotPath: String
    private let parentPid: pid_t
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var timer: Timer?
    private var lastMtime: TimeInterval = -1
    private var snapshot: Snapshot?

    private lazy var isoWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private lazy var isoStandard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private lazy var timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    init(snapshotPath: String, parentPid: pid_t) {
        self.snapshotPath = snapshotPath
        self.parentPid = parentPid
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        if let button = statusItem.button {
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            button.imagePosition = .imageLeading
        }

        pollOnce()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.pollOnce()
        }
        if let timer = timer {
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    private func checkParentAlive() {
        if parentPid > 0 {
            if Darwin.kill(parentPid, 0) != 0 && errno == ESRCH {
                NSApp.terminate(nil)
            }
        } else if getppid() == 1 {
            NSApp.terminate(nil)
        }
    }

    private func pollOnce() {
        checkParentAlive()
        guard !snapshotPath.isEmpty else {
            updateStatusButton()
            return
        }

        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: snapshotPath)
            let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            if mtime != lastMtime {
                let data = try Data(contentsOf: URL(fileURLWithPath: snapshotPath))
                let decoded = try JSONDecoder().decode(Snapshot.self, from: data)
                snapshot = decoded
                lastMtime = mtime
                updateStatusButton()
                rebuildMenu()
            }
        } catch {
            if snapshot == nil {
                updateStatusButton()
                rebuildMenu()
            }
        }
    }

    private func colorForFraction(_ fraction: Double) -> NSColor {
        let pct = fraction * 100.0
        if pct >= 50.0 {
            return NSColor.systemGreen
        }
        if pct >= 20.0 {
            return NSColor.systemOrange
        }
        return NSColor.systemRed
    }

    private func makeRingImage(fraction: Double?, color: NSColor) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            let center = NSPoint(x: 9, y: 9)
            let radius: CGFloat = 6.2
            let lineWidth: CGFloat = 2.4

            let track = NSBezierPath()
            track.appendArc(
                withCenter: center,
                radius: radius,
                startAngle: 0,
                endAngle: 360,
                clockwise: false
            )
            track.lineWidth = lineWidth
            NSColor.labelColor.withAlphaComponent(0.22).setStroke()
            track.stroke()

            if let frac = fraction, frac > 0 {
                let clamped = min(1.0, max(0.0, frac))
                let arc = NSBezierPath()
                arc.appendArc(
                    withCenter: center,
                    radius: radius,
                    startAngle: 90,
                    endAngle: 90 - 360 * CGFloat(clamped),
                    clockwise: true
                )
                arc.lineWidth = lineWidth
                arc.lineCapStyle = .round
                color.setStroke()
                arc.stroke()
            }

            return true
        }
        image.isTemplate = false
        return image
    }

    private func resolvePrimaryFraction() -> Double? {
        if let groups = snapshot?.groups, !groups.isEmpty {
            let geminiGroup = groups.first { group in
                let id = (group.id ?? "").lowercased()
                let name = (group.name ?? "").lowercased()
                return id == "gemini" || name.contains("gemini")
            }

            if let buckets = geminiGroup?.buckets, !buckets.isEmpty {
                if let fiveHour = buckets.first(where: {
                    $0.window == "5h" || ($0.id ?? "").lowercased().contains("5h")
                }) {
                    return min(1.0, max(0.0, fiveHour.remainingFraction ?? 0.0))
                }
                return min(1.0, max(0.0, buckets[0].remainingFraction ?? 0.0))
            }

            for group in groups {
                if let fiveHour = (group.buckets ?? []).first(where: {
                    $0.window == "5h" || ($0.id ?? "").lowercased().contains("5h")
                }) {
                    return min(1.0, max(0.0, fiveHour.remainingFraction ?? 0.0))
                }
            }

            for group in groups {
                if let first = group.buckets?.first {
                    return min(1.0, max(0.0, first.remainingFraction ?? 0.0))
                }
            }
        }

        if let pools = snapshot?.pools, !pools.isEmpty {
            if let geminiPool = pools.first(where: {
                ($0.name ?? "").lowercased().contains("gemini")
            }) {
                return min(1.0, max(0.0, geminiPool.remainingFraction ?? 0.0))
            }
            return pools.map { min(1.0, max(0.0, $0.remainingFraction ?? 0.0)) }.min()
        }

        return nil
    }

    private func updateStatusButton() {
        guard let button = statusItem.button else { return }

        guard let primaryFraction = resolvePrimaryFraction() else {
            button.image = makeRingImage(fraction: nil, color: .secondaryLabelColor)
            button.title = " --%"
            return
        }

        let pct = Int(round(primaryFraction * 100.0))
        button.image = makeRingImage(fraction: primaryFraction, color: colorForFraction(primaryFraction))
        button.title = " \(pct)%"
    }

    private func parseISODate(_ str: String?) -> Date? {
        guard let s = str, !s.isEmpty else { return nil }
        return isoWithFractional.date(from: s) ?? isoStandard.date(from: s)
    }

    private func formatResetTimer(resetTime: String?, untouched: Bool?, withPrefix: Bool) -> String {
        if untouched == true {
            return "полный лимит"
        }
        guard let date = parseISODate(resetTime) else {
            return "время сброса неизвестно"
        }
        let remaining = Int(date.timeIntervalSinceNow)
        if remaining <= 0 {
            return "сброс скоро"
        }
        let days = remaining / 86400
        let hours = (remaining % 86400) / 3600
        let mins = (remaining % 3600) / 60
        let secs = remaining % 60

        let dur: String
        if days > 0 {
            dur = "\(days)д \(hours)ч"
        } else if hours > 0 {
            dur = "\(hours)ч \(mins)м"
        } else if mins > 0 {
            dur = "\(mins)м"
        } else {
            dur = "\(secs)с"
        }
        return withPrefix ? "сброс через \(dur)" : dur
    }

    private func formatPercent(percent: Double?, remainingFraction: Double?) -> String {
        let rawPct = percent ?? ((remainingFraction ?? 0) * 100.0)
        let roundedTenth = (rawPct * 10.0).rounded() / 10.0
        if abs(roundedTenth - roundedTenth.rounded()) < 0.05 {
            return "\(Int(roundedTenth.rounded()))%"
        }
        return String(format: "%.1f%%", roundedTenth)
    }

    private func formatCredits(_ value: Double?) -> String {
        guard let value = value else { return "—" }
        if abs(value - value.rounded()) < 0.001 {
            return "\(Int(value.rounded()))"
        }
        return String(format: "%.1f", value)
    }

    private func bucketWindowTag(_ bucket: BucketInfo) -> String {
        switch bucket.window {
        case "5h":
            return "5ч"
        case "weekly":
            return "Нед"
        default:
            return bucket.shortLabel ?? bucket.label ?? bucket.window ?? "Квота"
        }
    }

    private func makeRowItem(
        left: NSAttributedString,
        right: NSAttributedString? = nil,
        topPad: CGFloat = 3,
        bottomPad: CGFloat = 3,
        leftPad: CGFloat = 14,
        rightPad: CGFloat = 14
    ) -> NSMenuItem {
        let width: CGFloat = 260
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 22))
        container.autoresizingMask = [.width]

        let leftLabel = NSTextField(labelWithAttributedString: left)
        leftLabel.translatesAutoresizingMaskIntoConstraints = false
        leftLabel.lineBreakMode = .byTruncatingTail
        container.addSubview(leftLabel)

        var constraints: [NSLayoutConstraint] = [
            leftLabel.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: leftPad),
            leftLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: topPad),
            leftLabel.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -bottomPad),
        ]

        if let right = right {
            let rightLabel = NSTextField(labelWithAttributedString: right)
            rightLabel.translatesAutoresizingMaskIntoConstraints = false
            rightLabel.alignment = .right
            rightLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
            rightLabel.setContentHuggingPriority(.required, for: .horizontal)
            container.addSubview(rightLabel)

            constraints.append(contentsOf: [
                rightLabel.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -rightPad),
                rightLabel.centerYAnchor.constraint(equalTo: leftLabel.centerYAnchor),
                leftLabel.trailingAnchor.constraint(lessThanOrEqualTo: rightLabel.leadingAnchor, constant: -10),
            ])
        } else {
            constraints.append(
                leftLabel.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -rightPad)
            )
        }

        NSLayoutConstraint.activate(constraints)
        container.layoutSubtreeIfNeeded()
        let fitting = container.fittingSize
        container.setFrameSize(NSSize(width: width, height: max(20, ceil(fitting.height))))

        let item = NSMenuItem()
        item.view = container
        return item
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        let headerLeft = NSAttributedString(
            string: "Antigravity Quotas",
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        let headerRight: NSAttributedString? = {
            guard let tier = snapshot?.plan?.tier, !tier.isEmpty else { return nil }
            return NSAttributedString(
                string: tier,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                    .foregroundColor: NSColor.labelColor.withAlphaComponent(0.75),
                ]
            )
        }()
        menu.addItem(makeRowItem(left: headerLeft, right: headerRight, topPad: 5, bottomPad: 4))

        let groups = (snapshot?.groups ?? []).filter { !($0.buckets ?? []).isEmpty }
        let pools = snapshot?.pools ?? []

        if !groups.isEmpty {
            for group in groups {
                let groupTitle = group.name ?? "Группа"
                let groupAttr = NSAttributedString(
                    string: groupTitle,
                    attributes: [
                        .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold),
                        .foregroundColor: NSColor.labelColor.withAlphaComponent(0.85),
                    ]
                )
                menu.addItem(makeRowItem(left: groupAttr, topPad: 6, bottomPad: 2))

                for bucket in group.buckets ?? [] {
                    let frac = min(1.0, max(0.0, bucket.remainingFraction ?? 0.0))
                    let color = colorForFraction(frac)
                    let winTag = bucketWindowTag(bucket)
                    let pctText = formatPercent(
                        percent: bucket.percent,
                        remainingFraction: bucket.remainingFraction
                    )
                    let timerText = formatResetTimer(
                        resetTime: bucket.resetTime,
                        untouched: bucket.untouched,
                        withPrefix: false
                    )

                    let leftAttr = NSMutableAttributedString(
                        string: "● ",
                        attributes: [
                            .foregroundColor: color,
                            .font: NSFont.systemFont(ofSize: 12),
                        ]
                    )
                    leftAttr.append(
                        NSAttributedString(
                            string: "\(winTag) ",
                            attributes: [
                                .foregroundColor: NSColor.labelColor.withAlphaComponent(0.85),
                                .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
                            ]
                        )
                    )
                    leftAttr.append(
                        NSAttributedString(
                            string: pctText,
                            attributes: [
                                .foregroundColor: NSColor.labelColor,
                                .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold),
                            ]
                        )
                    )

                    let rightColor = bucket.untouched == true
                        ? NSColor.systemGreen
                        : NSColor.labelColor.withAlphaComponent(0.8)
                    let rightAttr = NSAttributedString(
                        string: timerText,
                        attributes: [
                            .foregroundColor: rightColor,
                            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
                        ]
                    )

                    menu.addItem(makeRowItem(left: leftAttr, right: rightAttr, topPad: 2, bottomPad: 2))
                }
            }
        } else if !pools.isEmpty {
            for pool in pools {
                let frac = min(1.0, max(0.0, pool.remainingFraction ?? 0.0))
                let color = colorForFraction(frac)
                let name = pool.name ?? "Pool"
                let pctText = formatPercent(
                    percent: pool.percent,
                    remainingFraction: pool.remainingFraction
                )
                let timerText = formatResetTimer(
                    resetTime: pool.resetTime,
                    untouched: pool.untouched,
                    withPrefix: false
                )

                let leftAttr = NSMutableAttributedString(
                    string: "● ",
                    attributes: [
                        .foregroundColor: color,
                        .font: NSFont.systemFont(ofSize: 12),
                    ]
                )
                leftAttr.append(
                    NSAttributedString(
                        string: "\(name) ",
                        attributes: [
                            .foregroundColor: NSColor.labelColor.withAlphaComponent(0.85),
                            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
                        ]
                    )
                )
                leftAttr.append(
                    NSAttributedString(
                        string: pctText,
                        attributes: [
                            .foregroundColor: NSColor.labelColor,
                            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold),
                        ]
                    )
                )

                let rightColor = pool.untouched == true
                    ? NSColor.systemGreen
                    : NSColor.labelColor.withAlphaComponent(0.8)
                let rightAttr = NSAttributedString(
                    string: timerText,
                    attributes: [
                        .foregroundColor: rightColor,
                        .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
                    ]
                )

                menu.addItem(makeRowItem(left: leftAttr, right: rightAttr, topPad: 3, bottomPad: 3))
            }
        } else {
            let emptyAttr = NSAttributedString(
                string: "Ожидание данных о лимитах...",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 12),
                    .foregroundColor: NSColor.labelColor.withAlphaComponent(0.8),
                ]
            )
            menu.addItem(makeRowItem(left: emptyAttr, topPad: 4, bottomPad: 4))
        }

        menu.addItem(NSMenuItem.separator())

        let pCredits = snapshot?.plan?.promptCredits
        let fCredits = snapshot?.plan?.flowCredits
        if pCredits != nil || fCredits != nil {
            let creditsText = "Prompt: \(formatCredits(pCredits)) · Flow: \(formatCredits(fCredits))"
            let creditsAttr = NSAttributedString(
                string: creditsText,
                attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .regular),
                    .foregroundColor: NSColor.labelColor.withAlphaComponent(0.8),
                ]
            )
            menu.addItem(makeRowItem(left: creditsAttr, topPad: 2, bottomPad: 2))
        }

        if let updatedDate = parseISODate(snapshot?.updatedAt) {
            let updatedText = "Обновлено: \(timeFormatter.string(from: updatedDate))"
            let updatedAttr = NSAttributedString(
                string: updatedText,
                attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .regular),
                    .foregroundColor: NSColor.labelColor.withAlphaComponent(0.8),
                ]
            )
            menu.addItem(makeRowItem(left: updatedAttr, topPad: 2, bottomPad: 3))
        }

        if snapshot?.ok == false, let err = snapshot?.error, !err.isEmpty {
            let clipped = err.count > 72 ? String(err.prefix(72)) + "…" : err
            let errAttr = NSAttributedString(
                string: "Ошибка: \(clipped)",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11.5, weight: .regular),
                    .foregroundColor: NSColor.systemRed,
                ]
            )
            menu.addItem(makeRowItem(left: errAttr, topPad: 2, bottomPad: 3))
        }

        menu.addItem(NSMenuItem.separator())

        let hideItem = NSMenuItem(
            title: "Скрыть из Menu Bar",
            action: #selector(hideFromMenuBar),
            keyEquivalent: ""
        )
        hideItem.target = self
        menu.addItem(hideItem)
    }

    @objc private func hideFromMenuBar() {
        exit(42)
    }
}

var snapshotPath = ""
var parentPid: pid_t = 0
let args = CommandLine.arguments
var i = 1
while i < args.count {
    if args[i] == "--snapshot", i + 1 < args.count {
        snapshotPath = args[i + 1]
        i += 2
    } else if args[i] == "--parent-pid", i + 1 < args.count {
        parentPid = pid_t(Int32(args[i + 1]) ?? 0)
        i += 2
    } else {
        i += 1
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(snapshotPath: snapshotPath, parentPid: parentPid)
app.delegate = delegate
app.run()
