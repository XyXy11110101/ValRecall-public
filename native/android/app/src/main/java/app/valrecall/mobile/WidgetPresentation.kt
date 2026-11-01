package app.valrecall.mobile

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

enum class WidgetSize { COMPACT, MEDIUM, LARGE }

/**
 * Companion poses, in the manifest's widgetPoses order. The state picks the pose and the date picks
 * the outfit; the private release swaps the neutral fallbacks for other art.
 */
enum class WidgetPose { HEAD_SMILE, HEAD_TALK, HEAD_JOY, HEAD_WORRIED, CALM, SLEEPY, PEACE }

enum class WidgetMode { TASKS, ALL_DONE, NEXT_ONLY, EMPTY, NOT_READY, READ_ERROR, WORKSPACE_CHANGED, EXPIRED }

data class WidgetProgress(val done: Int, val plan: Int) {
    val percent: Int get() = if (plan <= 0) 0 else done * 100 / plan
    val label: String get() = "$done/$plan"
}

data class WidgetRowModel(
    val id: Long,
    val title: String,
    val meta: String,
    val overdue: Boolean,
    val description: String,
    val target: WidgetTarget,
)

data class WidgetModel(
    val mode: WidgetMode,
    val head: WidgetPose,
    val hero: WidgetPose?,
    /** Today's position in the 12-outfit rotation (WidgetWardrobe). */
    val outfit: Int,
    val bubble: String,
    val dateLabel: String?,
    val progress: WidgetProgress?,
    val rows: List<WidgetRowModel>,
    val moreCount: Int,
    val emptyTitle: String?,
    val emptyHint: String?,
    val next: WidgetRowModel?,
    val countLabel: String,
    val description: String,
)

/** Pure display rules: what each state says and shows. No Android types, so JVM-testable. */
object WidgetPresentation {
    const val COLLECTION_LIMIT = 50
    const val MORE_ITEM_ID = Long.MIN_VALUE
    private val weekdays = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    /**
     * [fallbackDate] only runs when the display has no date (a missing or unreadable cache), so the
     * worried face still wears today's outfit.
     */
    fun model(
        display: WidgetDisplay,
        limit: Int = COLLECTION_LIMIT,
        fallbackDate: () -> String = { systemDate(display.projection?.timeZone) },
    ): WidgetModel {
        val outfit = WidgetWardrobe.outfitIndex(display.date ?: fallbackDate())
        val projection = display.projection
        val day = display.day
        if (projection == null || day == null || display.status != "ready" || projection.epoch == null)
            return problem(display.status, outfit)
        val epoch = projection.epoch
        val rows = day.rows.take(limit).map { rowModel(it, day.date, epoch, next = false) }
        val progress = day.completed?.let { WidgetProgress(it, it + day.total) }
        val next = day.next?.let { rowModel(it, day.date, epoch, next = true) }
        val dateLabel = dateLabel(day.date)
        val done = day.completed ?: 0
        return when {
            day.total > 0 -> WidgetModel(
                WidgetMode.TASKS, WidgetPose.HEAD_TALK, null, outfit, "还有 ${day.total} 项", dateLabel, progress,
                rows, (day.total - rows.size).coerceAtLeast(0), null, null, null,
                progress?.label ?: "${day.total} 项", "ValRecall 待办，今天还有 ${day.total} 项",
            )
            done > 0 -> WidgetModel(
                WidgetMode.ALL_DONE, WidgetPose.HEAD_JOY, WidgetPose.PEACE, outfit, "都完成啦！", dateLabel,
                progress, emptyList(), 0, "今天的待办都完成了", null, next, progress?.label ?: "$done/$done",
                "ValRecall 待办，今天的待办都完成了",
            )
            next != null -> WidgetModel(
                WidgetMode.NEXT_ONLY, WidgetPose.HEAD_SMILE, WidgetPose.CALM, outfit, "今天没有待办", dateLabel,
                null, emptyList(), 0, "今天没有待办", null, next, "0 项", "ValRecall 待办，今天没有待办",
            )
            else -> WidgetModel(
                WidgetMode.EMPTY, WidgetPose.HEAD_SMILE, WidgetPose.SLEEPY, outfit, "今天没有安排", dateLabel,
                null, emptyList(), 0, "今天没有安排", "点 ＋ 添加一件要做的事", null, "0 项",
                "ValRecall 待办，今天没有安排",
            )
        }
    }

    private fun problem(status: String, outfit: Int): WidgetModel {
        val (mode, title, hint) = when (status) {
            "read-error" -> Triple(WidgetMode.READ_ERROR, "读取失败", "打开 App 重试")
            "workspace-changed" -> Triple(WidgetMode.WORKSPACE_CHANGED, "电脑数据已更换", "打开 App 查看")
            "expired" -> Triple(WidgetMode.EXPIRED, "待办需要更新", "打开 App 更新")
            else -> Triple(WidgetMode.NOT_READY, "还没有待办", "打开 App 完成设置")
        }
        return WidgetModel(
            mode, WidgetPose.HEAD_WORRIED, WidgetPose.HEAD_WORRIED, outfit, title, null, null, emptyList(), 0,
            title, hint, null, "—", "ValRecall 待办，$title，$hint",
        )
    }

    fun rowModel(row: WidgetRow, today: String, epoch: String, next: Boolean): WidgetRowModel {
        val meta = rowMeta(row, today, next)
        return WidgetRowModel(
            stableId(row.taskId, row.occurrenceDate),
            row.title,
            meta,
            !next && row.occurrenceDate < today,
            "${row.title}，$meta",
            WidgetTarget("task", epoch, row.taskId, row.occurrenceDate),
        )
    }

    /** Facts only: when, what time, priority and sync state. */
    fun rowMeta(row: WidgetRow, today: String, next: Boolean): String {
        val date = LocalDate.parse(row.occurrenceDate)
        val day = "${date.monthValue}/${date.dayOfMonth}"
        val whenText = when {
            next -> "下一项 · $day ${weekdays[date.dayOfWeek.value - 1]}"
            row.occurrenceDate < today -> "逾期 $day"
            else -> "今天"
        }
        val priority = when (row.priority) { "high" -> "优先"; "low" -> "稍后"; else -> null }
        return listOfNotNull(whenText, row.scheduledTime, priority, if (row.pending) "待同步" else null)
            .joinToString(" · ")
    }

    /** Today in the workspace zone when the cache names one, otherwise in the phone's zone. */
    fun systemDate(timeZone: String?, now: Instant = Instant.now()): String {
        val zone = timeZone?.let { try { ZoneId.of(it) } catch (_: RuntimeException) { null } } ?: ZoneId.systemDefault()
        return now.atZone(zone).toLocalDate().toString()
    }

    fun dateLabel(value: String): String {
        val date = LocalDate.parse(value)
        return "${date.monthValue}月${date.dayOfMonth}日 ${weekdays[date.dayOfWeek.value - 1]}"
    }

    /** FNV-1a over the occurrence identity, so the launcher keeps rows and scroll position. */
    fun stableId(taskId: String, date: String): Long {
        var hash = -0x340d631b7bdddcdbL
        for (character in "$taskId\u0000$date") {
            hash = hash xor character.code.toLong()
            hash *= 0x100000001b3L
        }
        return if (hash == MORE_ITEM_ID) hash + 1 else hash
    }

    fun sizeFor(widthDp: Float, heightDp: Float): WidgetSize = when {
        widthDp >= 240f && heightDp >= 260f -> WidgetSize.LARGE
        widthDp >= 240f && heightDp >= 120f -> WidgetSize.MEDIUM
        else -> WidgetSize.COMPACT
    }

    /** Rows that fit below the header on launchers without scrolling lists (API 26–30). */
    fun staticCapacity(heightDp: Int, fontScale: Float): Int {
        val scale = fontScale.coerceIn(1f, 3f)
        return ((heightDp - 150 * scale) / (56 * scale)).toInt().coerceIn(1, 8)
    }

    /** Shortly after the next local midnight, so "today" rolls over without the app. */
    fun nextDayBoundary(now: Instant, zone: ZoneId): Instant =
        now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().plusSeconds(60)
}
