package com.otani.ippitsu

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.SharedPreferences
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import es.antonborri.home_widget.HomeWidgetLaunchIntent
import es.antonborri.home_widget.HomeWidgetProvider
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一筆ホーム画面ウィジェットプロバイダ
 *
 * home_widget プラグイン経由で Dart 側から渡された JSON データを読み取り、
 * ウィジェットの各テキストビューにメモ内容をセットする。
 *
 * JSON データ構造:
 * {
 *   "memos": [
 *     { "id": 1, "preview": "...", "ai_importance": 0, "tags": [...], "has_reminder": true, "updated_at": 1234567890 },
 *     ...
 *   ],
 *   "total_count": 10,
 *   "updated_at": 1234567890
 * }
 */
class IppitsuWidgetProvider : HomeWidgetProvider() {

    companion object {
        private const val DATA_KEY = "ippitsu_widget_data"
        private const val MAX_VISIBLE_ITEMS = 8

        // 各カテゴリの dot drawable リソースID
        private val dotResMap = mapOf(
            "reminder" to R.drawable.priority_dot_reminder,
            "important" to R.drawable.priority_dot_important,
            "normal" to R.drawable.priority_dot_normal,
            "memo" to R.drawable.priority_dot_memo,
        )
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        widgetData: SharedPreferences
    ) {
        appWidgetIds.forEach { widgetId ->
            val views = RemoteViews(context.packageName, R.layout.ippitsu_widget).apply {
                // JSONデータを取得
                val jsonStr = widgetData.getString(DATA_KEY, null)

                // メモカウント
                val totalCount: Int
                val memos: List<MemoItem>

                if (jsonStr != null) {
                    try {
                        val json = JSONObject(jsonStr)
                        totalCount = json.optInt("total_count", 0)
                        memos = parseMemos(json.optJSONArray("memos"))
                    } catch (e: Exception) {
                        totalCount = 0
                        memos = emptyList()
                    }
                } else {
                    // データがない場合の初期表示
                    setTextViewText(R.id.memo_text_1, "メモを書くとここに表示されます")
                    setViewVisibility(R.id.priority_dot_1, View.GONE)
                    for (i in 2..MAX_VISIBLE_ITEMS) {
                        setViewVisibility(getMemoItemId(i), View.GONE)
                    }
                    totalCount = 0
                    memos = emptyList()
                }

                // メモ件数を表示
                setTextViewText(R.id.memo_count, if (totalCount > 0) "${totalCount}件" else "")

                // 各メモアイテムを設定
                for (i in 1..MAX_VISIBLE_ITEMS) {
                    val itemId = getMemoItemId(i)
                    val textId = getMemoTextId(i)
                    val dotId = getDotId(i)

                    if (i <= memos.size) {
                        val memo = memos[i - 1]
                        setViewVisibility(itemId, View.VISIBLE)
                        setTextViewText(textId, memo.preview)

                        // 優先度に応じたドットを設定
                        val dotRes = dotResMap[memo.category] ?: dotResMap["normal"]!!
                        setImageViewResource(dotId, dotRes)
                        setViewVisibility(dotId, View.VISIBLE)

                        // メモタップでアプリを開き、該当メモを表示
                        val tapUri = Uri.parse("homeWidget://memo?id=${memo.id}")
                        val pendingIntent = HomeWidgetLaunchIntent.getActivity(
                            context,
                            MainActivity::class.java,
                            tapUri
                        )
                        setOnClickPendingIntent(itemId, pendingIntent)
                    } else {
                        setViewVisibility(itemId, View.GONE)
                    }
                }
            }

            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }

    private fun parseMemos(jsonArray: JSONArray?): List<MemoItem> {
        if (jsonArray == null) return emptyList()
        val result = mutableListOf<MemoItem>()
        for (i in 0 until jsonArray.length()) {
            val obj = jsonArray.getJSONObject(i)
            val id = obj.getInt("id")
            val preview = obj.optString("preview", "")
            val importance = if (obj.has("ai_importance")) obj.optInt("ai_importance") else null
            val hasReminder = obj.optBoolean("has_reminder", false)
            val category = when {
                hasReminder -> "reminder"
                importance == 1 -> "important"
                importance == 2 -> "memo"
                else -> "normal"
            }
            result.add(MemoItem(id, preview, category))
        }
        return result
    }

    private fun getMemoItemId(index: Int): Int {
        return when (index) {
            1 -> R.id.memo_item_1
            2 -> R.id.memo_item_2
            3 -> R.id.memo_item_3
            4 -> R.id.memo_item_4
            5 -> R.id.memo_item_5
            6 -> R.id.memo_item_6
            7 -> R.id.memo_item_7
            8 -> R.id.memo_item_8
            else -> 0
        }
    }

    private fun getMemoTextId(index: Int): Int {
        return when (index) {
            1 -> R.id.memo_text_1
            2 -> R.id.memo_text_2
            3 -> R.id.memo_text_3
            4 -> R.id.memo_text_4
            5 -> R.id.memo_text_5
            6 -> R.id.memo_text_6
            7 -> R.id.memo_text_7
            8 -> R.id.memo_text_8
            else -> 0
        }
    }

    private fun getDotId(index: Int): Int {
        return when (index) {
            1 -> R.id.priority_dot_1
            2 -> R.id.priority_dot_2
            3 -> R.id.priority_dot_3
            4 -> R.id.priority_dot_4
            5 -> R.id.priority_dot_5
            6 -> R.id.priority_dot_6
            7 -> R.id.priority_dot_7
            8 -> R.id.priority_dot_8
            else -> 0
        }
    }

    data class MemoItem(
        val id: Int,
        val preview: String,
        val category: String // "reminder", "important", "normal", "memo"
    )
}
