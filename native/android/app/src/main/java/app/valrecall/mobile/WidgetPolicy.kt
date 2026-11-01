package app.valrecall.mobile

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

data class WidgetRow(
    val taskId: String,
    val occurrenceDate: String,
    val title: String,
    val scheduledTime: String?,
    val pending: Boolean,
    val priority: String = "normal",
)
/** `completed` is null for a version 1 cache written before the upgrade. */
data class WidgetDay(
    val date: String,
    val total: Int,
    val overdue: Int,
    val rows: List<WidgetRow>,
    val next: WidgetRow?,
    val completed: Int? = null,
)
data class WidgetProjection(
    val status: String,
    val reason: String?,
    val epoch: String?,
    val timeZone: String?,
    val generatedAt: String,
    val sourceSnapshotAt: String?,
    val days: List<WidgetDay>,
    val version: Int = 1,
)
data class WidgetDisplay(val projection: WidgetProjection?, val day: WidgetDay?, val status: String, val date: String?)

/** Validates display-only data. Task scheduling and mutations remain in the web repository. */
object WidgetPolicy {
    const val MAX_BYTES = 256 * 1024
    const val TODAY_ROWS = 50
    const val LATER_ROWS = 20
    private val priorities = setOf("high", "normal", "low")
    private val datePattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")
    private val timePattern = Regex("[0-9]{2}:[0-9]{2}")
    private val reasons = setOf("not-ready", "read-error", "workspace-changed")

    fun keys(value: JSONObject, expected: Set<String>) {
        require(value.keys().asSequence().toSet() == expected) { "小组件数据结构无效。" }
    }

    fun text(value: JSONObject, name: String): String {
        val raw = value.get(name)
        require(raw is String) { "小组件文字无效。" }
        return raw
    }

    private fun nullableText(value: JSONObject, name: String): String? =
        if (value.get(name) === JSONObject.NULL) null else text(value, name)

    fun integer(value: JSONObject, name: String, maximum: Long = 9_007_199_254_740_991L): Long {
        val raw = value.get(name)
        require(raw is Int || raw is Long) { "小组件计数无效。" }
        val number = (raw as Number).toLong()
        require(number in 0..maximum) { "小组件计数超出范围。" }
        return number
    }

    fun date(value: String): LocalDate {
        require(datePattern.matches(value))
        return LocalDate.parse(value)
    }

    fun validTaskId(value: String): Boolean = value.isNotBlank() && value.length <= 512

    private fun timestamp(value: String) {
        require(value.length <= 40)
        Instant.parse(value)
    }

    private fun row(value: JSONObject, version: Int): WidgetRow {
        val rowKeys = setOf("taskId", "occurrenceDate", "title", "scheduledTime", "pending")
        keys(value, if (version == 1) rowKeys else rowKeys + "priority")
        val taskId = text(value, "taskId")
        require(validTaskId(taskId))
        val occurrence = text(value, "occurrenceDate")
        date(occurrence)
        val title = text(value, "title")
        require(title.isNotBlank() && title.length <= 160)
        val time = nullableText(value, "scheduledTime")
        if (time != null) { require(timePattern.matches(time)); LocalTime.parse(time) }
        val pending = value.get("pending")
        require(pending is Boolean)
        val priority = if (version == 1) "normal" else text(value, "priority")
        require(priority in priorities)
        return WidgetRow(taskId, occurrence, title, time, pending, priority)
    }

    fun parse(raw: String): WidgetProjection {
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "小组件数据过大。" }
        val value = JSONObject(raw)
        keys(value, setOf("version", "status", "reason", "epoch", "timeZone", "generatedAt", "sourceSnapshotAt", "days"))
        val version = integer(value, "version", 2).toInt()
        require(version == 1 || version == 2)
        val status = text(value, "status")
        require(status in setOf("ready", "unavailable"))
        val reason = nullableText(value, "reason")
        val epoch = nullableText(value, "epoch")
        if (epoch != null) require(NativePolicy.validIdentifier(epoch))
        val zone = nullableText(value, "timeZone")
        if (zone != null) { require(zone.length <= 100); ZoneId.of(zone) }
        val generatedAt = text(value, "generatedAt")
        timestamp(generatedAt)
        val sourceAt = nullableText(value, "sourceSnapshotAt")
        if (sourceAt != null) timestamp(sourceAt)
        val days = value.getJSONArray("days")
        if (status == "unavailable") {
            require(reason in reasons && days.length() == 0 && epoch == null && zone == null && sourceAt == null)
            return WidgetProjection(status, reason, epoch, zone, generatedAt, sourceAt, emptyList(), version)
        }
        require(reason == null && epoch != null && zone != null && sourceAt != null && days.length() == 14)
        val firstDate = Instant.parse(generatedAt).atZone(ZoneId.of(zone)).toLocalDate()
        val parsed = (0 until days.length()).map { index ->
            val day = days.getJSONObject(index)
            val dayKeys = setOf("date", "total", "overdue", "rows", "next")
            keys(day, if (version == 1) dayKeys else dayKeys + "completed")
            val dayDate = text(day, "date")
            require(date(dayDate) == firstDate.plusDays(index.toLong()))
            val total = integer(day, "total", Int.MAX_VALUE.toLong()).toInt()
            val overdue = integer(day, "overdue", total.toLong()).toInt()
            val completed = if (version == 1) null else integer(day, "completed", Int.MAX_VALUE.toLong()).toInt()
            val rows = day.getJSONArray("rows")
            if (version == 1) require(rows.length() == minOf(total, 5))
            else {
                // Version 2 trims later days first to fit the cache; today always keeps a row.
                require(rows.length() <= minOf(total, if (index == 0) TODAY_ROWS else LATER_ROWS))
                require(index != 0 || total == 0 || rows.length() > 0)
            }
            val parsedRows = (0 until rows.length()).map { row(rows.getJSONObject(it), version) }
            require(parsedRows.all { it.occurrenceDate <= dayDate })
            require(parsedRows.map { Pair(it.taskId, it.occurrenceDate) }.toSet().size == parsedRows.size)
            val next = if (day.get("next") === JSONObject.NULL) null else row(day.getJSONObject("next"), version)
            require(next == null || (total == 0 && next.occurrenceDate > dayDate))
            WidgetDay(dayDate, total, overdue, parsedRows, next, completed)
        }
        return WidgetProjection(status, reason, epoch, zone, generatedAt, sourceAt, parsed, version)
    }

    fun validatePublish(payload: JSONObject) {
        keys(payload, setOf("sequence", "projection"))
        require(integer(payload, "sequence") > 0)
        parse(payload.getJSONObject("projection").toString())
    }

    fun display(raw: String?, now: Instant = Instant.now()): WidgetDisplay {
        if (raw == null) return WidgetDisplay(null, null, "not-ready", null)
        val projection = try { parse(raw) } catch (_: Exception) { return WidgetDisplay(null, null, "read-error", null) }
        val today = projection.timeZone?.let { now.atZone(ZoneId.of(it)).toLocalDate().toString() }
        if (projection.status != "ready") return WidgetDisplay(projection, null, projection.reason!!, today)
        val day = projection.days.firstOrNull { it.date == today }
        return WidgetDisplay(projection, day, if (day == null) "expired" else "ready", today)
    }

}

/** A new WebView owner revokes older queued writers even when their timestamps are newer. */
class WidgetWriteOrder {
    private var owner: String? = null
    private var sequence = 0L

    fun begin(session: String) { owner = session; sequence = 0L }
    fun current(session: String, next: Long): Boolean = session == owner && next > sequence
    fun committed(session: String, next: Long) { check(current(session, next)); sequence = next }
    fun end(session: String) { if (owner == session) owner = null }
}
