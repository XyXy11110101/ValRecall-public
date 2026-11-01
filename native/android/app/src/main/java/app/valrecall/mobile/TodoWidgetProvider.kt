package app.valrecall.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.core.net.toUri
import java.time.Instant
import java.time.ZoneId

class TodoWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = renderAll(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        renderAll(context, manager, intArrayOf(id))

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_DAY_CHANGED) refresh(context)
    }

    override fun onDisabled(context: Context) {
        context.getSystemService(AlarmManager::class.java)?.cancel(dayChange(context))
    }

    companion object {
        private const val ACTION_DAY_CHANGED = "app.valrecall.mobile.WIDGET_DAY_CHANGED"
        private const val DEGRADED_ROWS = 20

        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, TodoWidgetProvider::class.java))
            if (ids.isNotEmpty()) renderAll(context, manager, ids)
        }

        private fun renderAll(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val display = WidgetPolicy.display(WidgetStore(context).read())
            val model = WidgetPresentation.model(display)
            ids.forEach { render(context, manager, it, model) }
            scheduleDayChange(context, display)
        }

        private fun render(context: Context, manager: AppWidgetManager, id: Int, model: WidgetModel) {
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    manager.updateAppWidget(id, Widget31.responsive(context, id, model))
                } catch (_: RuntimeException) {
                    // A launcher may reject a large parcel; one shorter layout still shows the day.
                    val shorter = model.copy(
                        rows = model.rows.take(DEGRADED_ROWS),
                        moreCount = model.moreCount + (model.rows.size - DEGRADED_ROWS).coerceAtLeast(0),
                    )
                    manager.updateAppWidget(id, Widget31.single(context, id, shorter, WidgetSize.LARGE))
                }
            } else manager.updateAppWidget(id, legacy(context, manager, id, model))
        }

        /** A non-wakeup alarm just after local midnight re-reads the cached 14 days. */
        private fun scheduleDayChange(context: Context, display: WidgetDisplay) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val zone = display.projection?.timeZone?.let { ZoneId.of(it) } ?: ZoneId.systemDefault()
            val at = WidgetPresentation.nextDayBoundary(Instant.now(), zone).toEpochMilli()
            alarms.setWindow(AlarmManager.RTC, at, 15 * 60 * 1000L, dayChange(context))
        }

        private fun dayChange(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, 0,
            Intent(context, TodoWidgetProvider::class.java).setAction(ACTION_DAY_CHANGED),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /** Immutable, one per destination (header, ＋, next card and the static rows). */
        internal fun destination(context: Context, widgetId: Int, target: WidgetTarget): PendingIntent {
            val identity = Uri.Builder().scheme("valrecall-widget").authority("open")
                .appendPath(widgetId.toString()).appendPath(target.kind)
                .appendPath(target.epoch ?: "").appendPath(target.taskId ?: "").appendPath(target.occurrenceDate ?: "").build()
            val intent = Intent(context, MainActivity::class.java).apply {
                action = WidgetNavigation.ACTION
                data = identity
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(WidgetNavigation.EXTRA, target.json().toString())
            }
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        /** The neutral vector, also the fallback when an outfit slot is missing. */
        internal fun pose(pose: WidgetPose): Int = when (pose) {
            WidgetPose.HEAD_SMILE -> R.drawable.widget_pose_head_smile
            WidgetPose.HEAD_TALK -> R.drawable.widget_pose_head_talk
            WidgetPose.HEAD_JOY -> R.drawable.widget_pose_head_joy
            WidgetPose.HEAD_WORRIED -> R.drawable.widget_pose_head_worried
            WidgetPose.CALM -> R.drawable.widget_pose_calm
            WidgetPose.SLEEPY -> R.drawable.widget_pose_sleepy
            WidgetPose.PEACE -> R.drawable.widget_pose_peace
        }

        internal fun arrayFor(pose: WidgetPose): Int = when (pose) {
            WidgetPose.HEAD_SMILE -> R.array.widget_wardrobe_head_smile
            WidgetPose.HEAD_TALK -> R.array.widget_wardrobe_head_talk
            WidgetPose.HEAD_JOY -> R.array.widget_wardrobe_head_joy
            WidgetPose.HEAD_WORRIED -> R.array.widget_wardrobe_head_worried
            WidgetPose.CALM -> R.array.widget_wardrobe_calm
            WidgetPose.SLEEPY -> R.array.widget_wardrobe_sleepy
            WidgetPose.PEACE -> R.array.widget_wardrobe_peace
        }

        /** Today's outfit for this pose: the private overlay's art, or the neutral vector. */
        internal fun art(context: Context, pose: WidgetPose, outfit: Int): Int {
            val fallback = pose(pose)
            val slots = context.resources.obtainTypedArray(arrayFor(pose))
            try {
                return if (outfit in 0 until slots.length()) slots.getResourceId(outfit, fallback) else fallback
            } finally {
                slots.recycle()
            }
        }

        /** Shared by every size: companion, bubble, date, progress and the ＋ button. */
        internal fun header(context: Context, views: RemoteViews, id: Int, model: WidgetModel) {
            val open = destination(context, id, WidgetTarget("tasks"))
            views.setOnClickPendingIntent(android.R.id.background, open)
            views.setContentDescription(android.R.id.background, model.description)
            views.setOnClickPendingIntent(R.id.widget_add, destination(context, id, WidgetTarget("add-task")))
            views.setImageViewResource(R.id.widget_pose, art(context, model.head, model.outfit))
            views.setTextViewText(R.id.widget_bubble, model.bubble)
            views.setTextViewText(R.id.widget_date, model.dateLabel ?: "ValRecall")
            val progress = model.progress
            views.setTextViewText(R.id.widget_progress_label, progress?.label ?: "")
            views.setViewVisibility(R.id.widget_progress_label, if (progress == null) View.GONE else View.VISIBLE)
            views.setViewVisibility(R.id.widget_progress, if (progress == null) View.GONE else View.VISIBLE)
            if (progress != null) views.setProgressBar(R.id.widget_progress, 100, progress.percent, false)
        }

        /** The empty area: a larger companion pose, one line, and the next arrangement if any. */
        internal fun emptyArea(context: Context, views: RemoteViews, id: Int, model: WidgetModel) {
            views.setImageViewResource(R.id.widget_hero, art(context, model.hero ?: model.head, model.outfit))
            views.setTextViewText(R.id.widget_empty_title, model.emptyTitle ?: "")
            views.setTextViewText(R.id.widget_empty_hint, model.emptyHint ?: "")
            views.setViewVisibility(R.id.widget_empty_hint, if (model.emptyHint == null) View.GONE else View.VISIBLE)
            val next = model.next
            if (next == null) views.setViewVisibility(R.id.widget_next, View.GONE)
            else {
                views.setViewVisibility(R.id.widget_next, View.VISIBLE)
                views.setTextViewText(R.id.widget_next, "${next.meta} · ${next.title}")
                views.setContentDescription(R.id.widget_next, next.description)
                views.setOnClickPendingIntent(R.id.widget_next, destination(context, id, next.target))
            }
        }

        internal fun compactViews(context: Context, id: Int, model: WidgetModel): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.todo_widget_compact)
            header(context, views, id, model)
            views.setTextViewText(R.id.widget_count, model.countLabel)
            views.setTextViewText(R.id.widget_line, model.rows.firstOrNull()?.title ?: model.emptyTitle ?: model.bubble)
            return views
        }

        internal fun item(context: Context, row: WidgetRowModel): RemoteViews =
            RemoteViews(context.packageName, if (row.overdue) R.layout.todo_widget_item_overdue else R.layout.todo_widget_item).apply {
                setTextViewText(R.id.widget_item_title, row.title)
                setTextViewText(R.id.widget_item_meta, row.meta)
                setContentDescription(R.id.widget_item, row.description)
            }

        /** API 26–30: no scrolling list, so show the rows that fit. */
        private fun legacy(context: Context, manager: AppWidgetManager, id: Int, model: WidgetModel): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.todo_widget)
            header(context, views, id, model)
            views.removeAllViews(R.id.widget_rows)
            val options = manager.getAppWidgetOptions(id)
            val portrait = context.resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
            val height = options.getInt(if (portrait) AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 260)
            val capacity = WidgetPresentation.staticCapacity(height, context.resources.configuration.fontScale)
            if (model.rows.isEmpty()) {
                views.setViewVisibility(R.id.widget_empty, View.VISIBLE)
                emptyArea(context, views, id, model)
            } else {
                views.setViewVisibility(R.id.widget_empty, View.GONE)
                model.rows.take(capacity).forEach { row ->
                    val entry = item(context, row)
                    entry.setOnClickPendingIntent(R.id.widget_item, destination(context, id, row.target))
                    views.addView(R.id.widget_rows, entry)
                }
            }
            return views
        }
    }
}

/** Android 12+: responsive sizes and a scrolling list of every open task. */
@RequiresApi(31)
private object Widget31 {
    private val sizes = listOf(
        SizeF(100f, 100f) to WidgetSize.COMPACT,
        SizeF(240f, 120f) to WidgetSize.MEDIUM,
        SizeF(240f, 260f) to WidgetSize.LARGE,
    )

    fun responsive(context: Context, id: Int, model: WidgetModel): RemoteViews =
        RemoteViews(sizes.associate { (size, bucket) -> size to single(context, id, model, bucket) })

    fun single(context: Context, id: Int, model: WidgetModel, size: WidgetSize): RemoteViews {
        if (size == WidgetSize.COMPACT) return TodoWidgetProvider.compactViews(context, id, model)
        val views = RemoteViews(context.packageName, if (size == WidgetSize.LARGE) R.layout.todo_widget_large else R.layout.todo_widget_medium)
        TodoWidgetProvider.header(context, views, id, model)
        TodoWidgetProvider.emptyArea(context, views, id, model)
        val items = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(3)
        model.rows.forEach { row ->
            val entry = TodoWidgetProvider.item(context, row)
            entry.setOnClickFillInIntent(R.id.widget_item, fillIn(row.target))
            items.addItem(row.id, entry)
        }
        if (model.moreCount > 0) {
            val more = RemoteViews(context.packageName, R.layout.todo_widget_more)
            more.setTextViewText(R.id.widget_item, "还有 ${model.moreCount} 项 · 打开查看")
            more.setOnClickFillInIntent(R.id.widget_item, fillIn(WidgetTarget("tasks")))
            items.addItem(WidgetPresentation.MORE_ITEM_ID, more)
        }
        // Always set the adapter, even when empty, so stale rows never linger.
        views.setRemoteAdapter(R.id.widget_list, items.build())
        views.setEmptyView(R.id.widget_list, R.id.widget_empty)
        views.setPendingIntentTemplate(R.id.widget_list, template(context, id))
        return views
    }

    /** The fill-in only adds the target extra; MainActivity validates it as before. */
    private fun fillIn(target: WidgetTarget) = Intent().putExtra(WidgetNavigation.EXTRA, target.json().toString())

    /**
     * Mutable so rows can fill in their target. Component, action and data are fixed here, and
     * no FILL_IN_* flag is set, so a fill-in can only merge extras.
     */
    private fun template(context: Context, id: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = WidgetNavigation.ACTION
            data = "valrecall-widget://list/$id".toUri()
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
    }
}
