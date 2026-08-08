//
//  IppitsuWidgetLiveActivity.swift
//  IppitsuWidget
//
//  Created by 大谷涼 on 2026/06/07.
//

import ActivityKit
import WidgetKit
import SwiftUI

struct IppitsuWidgetAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        // Dynamic stateful properties about your activity go here!
        var emoji: String
    }

    // Fixed non-changing properties about your activity go here!
    var name: String
}

struct IppitsuWidgetLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: IppitsuWidgetAttributes.self) { context in
            // Lock screen/banner UI goes here
            VStack {
                Text("Hello \(context.state.emoji)")
            }
            .activityBackgroundTint(Color.cyan)
            .activitySystemActionForegroundColor(Color.black)

        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded UI goes here.  Compose the expanded UI through
                // various regions, like leading/trailing/center/bottom
                DynamicIslandExpandedRegion(.leading) {
                    Text("Leading")
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("Trailing")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("Bottom \(context.state.emoji)")
                    // more content
                }
            } compactLeading: {
                Text("L")
            } compactTrailing: {
                Text("T \(context.state.emoji)")
            } minimal: {
                Text(context.state.emoji)
            }
            .widgetURL(URL(string: "http://www.apple.com"))
            .keylineTint(Color.red)
        }
    }
}

extension IppitsuWidgetAttributes {
    fileprivate static var preview: IppitsuWidgetAttributes {
        IppitsuWidgetAttributes(name: "World")
    }
}

extension IppitsuWidgetAttributes.ContentState {
    fileprivate static var smiley: IppitsuWidgetAttributes.ContentState {
        IppitsuWidgetAttributes.ContentState(emoji: "😀")
     }
     
     fileprivate static var starEyes: IppitsuWidgetAttributes.ContentState {
         IppitsuWidgetAttributes.ContentState(emoji: "🤩")
     }
}

#Preview("Notification", as: .content, using: IppitsuWidgetAttributes.preview) {
   IppitsuWidgetLiveActivity()
} contentStates: {
    IppitsuWidgetAttributes.ContentState.smiley
    IppitsuWidgetAttributes.ContentState.starEyes
}
