//
//  AppIntent.swift
//  IppitsuWidget
//
//  一筆ウィジェット用 ConfigurationIntent（現在は設定項目なし、拡張用）
//

import WidgetKit
import AppIntents

struct ConfigurationAppIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "一筆メモ" }
    static var description: LocalizedStringResource { "AI分析による優先順位でメモを表示します" }
}

