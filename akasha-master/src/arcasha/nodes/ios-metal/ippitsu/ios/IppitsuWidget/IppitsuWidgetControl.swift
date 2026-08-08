//
//  IppitsuWidgetControl.swift
//  IppitsuWidget
//
//  Control Widget（将来拡張用）
//

import AppIntents
import SwiftUI
import WidgetKit

struct IppitsuWidgetControl: ControlWidget {
    static let kind: String = "com.otani.ippitsu.Widget"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: Self.kind
        ) {
            ControlWidgetButton(action: OpenAppIntent()) {
                Label("一筆を開く", systemImage: "note.text")
            }
        }
        .displayName("一筆")
        .description("メモアプリ「一筆」を開きます")
    }
}

struct OpenAppIntent: AppIntent {
    static var title: LocalizedStringResource { "一筆を開く" }

    func perform() async throws -> some IntentResult {
        return .result()
    }
}

