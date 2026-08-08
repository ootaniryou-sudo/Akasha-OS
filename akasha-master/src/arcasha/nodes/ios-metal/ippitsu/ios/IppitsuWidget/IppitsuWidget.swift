//
//  IppitsuWidget.swift
//  IppitsuWidget
//
//  一筆（いっぴつ）ホーム画面ウィジェット
//  Flutter 側 (home_widget) から App Group の UserDefaults に保存された
//  JSON データを読み取り、AI分析による優先順位でメモを表示する
//

import WidgetKit
import SwiftUI

// MARK: - App Group（Flutter 側の HomeWidget.setAppGroupId と一致させる）
private let widgetGroupId = "group.com.otani.ippitsu.widget"

// MARK: - データモデル

struct WidgetMemo: Decodable, Identifiable {
    let id: Int
    let preview: String
    let ai_importance: Int?
    let tags: [String]
    let has_reminder: Bool
    let updated_at: Int

    var category: MemoCategory {
        if has_reminder { return .reminder }
        switch ai_importance {
        case 1: return .important
        case 2: return .memo
        default: return .normal
        }
    }
}

enum MemoCategory: String {
    case reminder
    case important
    case normal
    case memo

    var color: Color {
        switch self {
        case .reminder: return .orange
        case .important: return .red
        case .normal: return .gray
        case .memo: return .blue
        }
    }

    var icon: String {
        switch self {
        case .reminder: return "⏰"
        case .important: return "!"
        case .normal: return ""
        case .memo: return "📝"
        }
    }
}

struct WidgetData: Decodable {
    let memos: [WidgetMemo]
    let totalCount: Int
    let updatedAt: Int

    enum CodingKeys: String, CodingKey {
        case memos
        case totalCount = "total_count"
        case updatedAt = "updated_at"
    }
}

// MARK: - Timeline Entry

struct SimpleEntry: TimelineEntry {
    let date: Date
    let memos: [WidgetMemo]
    let totalCount: Int
}

// MARK: - Timeline Provider

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> SimpleEntry {
        SimpleEntry(
            date: Date(),
            memos: [
                WidgetMemo(id: 1, preview: "メモサンプル", ai_importance: 0, tags: [], has_reminder: false, updated_at: Int(Date().timeIntervalSince1970)),
            ],
            totalCount: 1
        )
    }

    func snapshot(for configuration: ConfigurationAppIntent, in context: Context) async -> SimpleEntry {
        loadData()
    }

    func timeline(for configuration: ConfigurationAppIntent, in context: Context) async -> Timeline<SimpleEntry> {
        let entry = loadData()
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
        return Timeline(entries: [entry], policy: .after(nextUpdate))
    }

    private func loadData() -> SimpleEntry {
        let defaults = UserDefaults(suiteName: widgetGroupId)
        guard let jsonStr = defaults?.string(forKey: "ippitsu_widget_data"),
              let jsonData = jsonStr.data(using: .utf8) else {
            return SimpleEntry(date: Date(), memos: [], totalCount: 0)
        }
        let decoder = JSONDecoder()
        guard let data = try? decoder.decode(WidgetData.self, from: jsonData) else {
            return SimpleEntry(date: Date(), memos: [], totalCount: 0)
        }
        return SimpleEntry(date: Date(), memos: data.memos, totalCount: data.totalCount)
    }
}

// MARK: - メモ行ビュー

struct MemoRowView: View {
    let memo: WidgetMemo
    let showTags: Bool

    var body: some View {
        Link(destination: URL(string: "homeWidget://memo?id=\(memo.id)")!) {
            HStack(spacing: 8) {
                Circle()
                    .fill(memo.category.color)
                    .frame(width: 8, height: 8)

                Text(memo.preview)
                    .font(.system(size: 13))
                    .lineLimit(2)
                    .foregroundColor(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !memo.category.icon.isEmpty {
                    Text(memo.category.icon)
                        .font(.caption2)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - ウィジェットビュー（3サイズ対応）

struct IppitsuWidgetEntryView: View {
    var entry: SimpleEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        if entry.memos.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "note.text")
                    .font(.title2)
                    .foregroundColor(.secondary)
                Text("メモがありません")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text("アプリを開いてメモを書いてください")
                    .font(.caption2)
                    .foregroundColor(.secondary.opacity(0.7))
                    .multilineTextAlignment(.center)
            }
            .containerBackground(.background, for: .widget)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("一筆")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.primary)
                    Spacer()
                    if entry.totalCount > 0 {
                        Text("\(entry.totalCount)件")
                            .font(.system(size: 11))
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.bottom, 6)

                ForEach(displayMemos) { memo in
                    MemoRowView(memo: memo, showTags: family == .systemLarge)
                }

                Spacer(minLength: 0)
            }
            .containerBackground(.background, for: .widget)
        }
    }

    private var displayMemos: [WidgetMemo] {
        switch family {
        case .systemSmall:
            return Array(entry.memos.prefix(2))
        case .systemMedium:
            return Array(entry.memos.prefix(5))
        case .systemLarge:
            return Array(entry.memos.prefix(10))
        @unknown default:
            return Array(entry.memos.prefix(5))
        }
    }
}

// MARK: - ウィジェット定義

struct IppitsuWidget: Widget {
    let kind: String = "IppitsuWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ConfigurationAppIntent.self, provider: Provider()) { entry in
            IppitsuWidgetEntryView(entry: entry)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("一筆メモ")
        .description("AI分析による優先順位でメモを表示します")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .systemLarge,
        ])
    }
}

