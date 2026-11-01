package app.valrecall.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class WidgetPolicyTest {
    private fun row(id: String = "synthetic-task", date: String = "2026-10-26") = JSONObject()
        .put("taskId", id).put("occurrenceDate", date).put("title", "复习一张卡片")
        .put("scheduledTime", "09:30").put("pending", false)

    private fun projection(): JSONObject {
        val days = JSONArray()
        for (offset in 0..13) {
            val date = LocalDate.parse("2026-10-26").plusDays(offset.toLong()).toString()
            days.put(JSONObject().put("date", date).put("total", 1).put("overdue", 0)
                .put("rows", JSONArray().put(row(date = date))).put("next", JSONObject.NULL))
        }
        return JSONObject().put("version", 1).put("status", "ready").put("reason", JSONObject.NULL)
            .put("epoch", "synthetic-epoch").put("timeZone", "Europe/London")
            .put("generatedAt", "2026-10-26T09:00:00.000Z").put("sourceSnapshotAt", "2026-10-25T09:00:00.000Z")
            .put("days", days)
    }

    private fun rejects(change: (JSONObject) -> Unit) {
        val value = projection()
        change(value)
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
    }

    @Test fun acceptsOnlyTheVersionedBoundedDisplayContract() {
        val value = projection()
        val result = WidgetPolicy.parse(value.toString())
        assertEquals(14, result.days.size)
        assertEquals("复习一张卡片", result.days[0].rows[0].title)
        rejects { it.put("version", "1") }
        rejects { it.put("notes", "private") }
        rejects { it.put("timeZone", "invalid-zone") }
        rejects { it.put("epoch", "a/../b") }
        rejects { it.put("sourceSnapshotAt", "yesterday") }
        rejects { it.put("sourceSnapshotAt", JSONObject.NULL) }
        rejects { it.put("days", JSONArray()) }
        rejects { it.getJSONArray("days").getJSONObject(1).put("date", "2026-10-26") }
        rejects { it.getJSONArray("days").getJSONObject(0).put("overdue", 2) }
        rejects { it.getJSONArray("days").getJSONObject(0).put("total", 1.5) }
        rejects { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).put("pending", "false") }
        rejects { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).put("title", "x".repeat(161)) }
        rejects { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).put("scheduledTime", "25:30") }
        rejects { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).put("occurrenceDate", "2026-10-27") }
        assertThrows(Exception::class.java) { WidgetPolicy.parse(" ".repeat(WidgetPolicy.MAX_BYTES + 1)) }
    }

    @Test fun enforcesMaximumRowsAndDistinctOccurrencesWithoutDroppingTheTotal() {
        val value = projection()
        val day = value.getJSONArray("days").getJSONObject(0)
        val rows = JSONArray()
        for (index in 0..4) rows.put(row(id = "task-$index"))
        day.put("rows", rows).put("total", 100)
        assertEquals(100, WidgetPolicy.parse(value.toString()).days[0].total)
        rows.put(row(id = "task-5"))
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
        rows.remove(5)
        rows.put(4, row(id = "task-0"))
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
    }

    @Test fun taskIdsRemainOpaqueAndAcceptTheSnapshotLengthBoundary() {
        val value = projection()
        val task = value.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0)
        val opaqueId = "任务:本周/复习:" + "中".repeat(503)
        assertEquals(512, opaqueId.length)
        task.put("taskId", opaqueId).put("title", "读\u0000书")
        val parsed = WidgetPolicy.parse(value.toString()).days[0].rows[0]
        assertEquals(opaqueId, parsed.taskId)
        assertEquals("读\u0000书", parsed.title)
        task.put("taskId", opaqueId + "中")
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
        task.put("taskId", "   ")
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
    }

    @Test fun distinguishesNoTasksFromMissingCorruptAndExpiredCaches() {
        val value = projection()
        val day = value.getJSONArray("days").getJSONObject(0)
        day.put("total", 0).put("rows", JSONArray())
        assertEquals(0, WidgetPolicy.display(value.toString(), Instant.parse("2026-10-26T12:00:00Z")).day!!.total)
        assertEquals("not-ready", WidgetPolicy.display(null).status)
        assertEquals("read-error", WidgetPolicy.display("broken").status)
        val expired = WidgetPolicy.display(value.toString(), Instant.parse("2026-11-09T12:00:00Z"))
        assertEquals("expired", expired.status)
        assertNull(expired.day)
        value.put("status", "unavailable").put("reason", "read-error").put("days", JSONArray())
            .put("epoch", JSONObject.NULL).put("timeZone", JSONObject.NULL).put("sourceSnapshotAt", JSONObject.NULL)
        assertEquals("unavailable", WidgetPolicy.parse(value.toString()).status)
        assertEquals("read-error", WidgetPolicy.display(value.toString()).status)
    }

    @Test fun unavailableProjectionCannotRetainAnOlderWorkspaceIdentityOrSnapshot() {
        val value = projection().put("status", "unavailable").put("reason", "workspace-changed")
            .put("days", JSONArray()).put("epoch", JSONObject.NULL).put("timeZone", JSONObject.NULL)
            .put("sourceSnapshotAt", JSONObject.NULL)
        assertEquals("workspace-changed", WidgetPolicy.parse(value.toString()).reason)
        val oldFields = mapOf("epoch" to "old-epoch", "timeZone" to "Europe/London", "sourceSnapshotAt" to "2026-10-25T09:00:00Z")
        oldFields.forEach { (key, oldValue) ->
            val invalid = JSONObject(value.toString()).put(key, oldValue)
            assertThrows(Exception::class.java) { WidgetPolicy.parse(invalid.toString()) }
        }
    }

    @Test fun nextArrangementIsFutureAndOnlyShownWhenNothingIsDue() {
        val value = projection()
        val day = value.getJSONArray("days").getJSONObject(0)
        day.put("next", row(date = "2027-01-01"))
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
        day.put("total", 0).put("rows", JSONArray())
        assertEquals("2027-01-01", WidgetPolicy.parse(value.toString()).days[0].next!!.occurrenceDate)
        day.put("next", row(date = "2026-10-26"))
        assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
    }

    @Test fun selectsWorkspaceDateAndRefreshesRepeatedTasksAcrossMidnight() {
        val value = projection()
        value.put("timeZone", "Asia/Shanghai").put("generatedAt", "2026-10-25T18:00:00Z")
        val late = WidgetPolicy.display(value.toString(), Instant.parse("2026-10-26T17:00:00Z"))
        assertEquals("2026-10-27", late.day!!.date)
        assertEquals("2026-10-27", late.day.rows[0].occurrenceDate)
    }

    @Test fun nativePublishRequiresAnExactSequenceAndPayload() {
        val envelope = JSONObject().put("id", "request-1").put("type", "widget.publish")
            .put("payload", JSONObject().put("sequence", 1).put("projection", projection()))
        assertEquals("widget.publish", NativePolicy.parseRequest(envelope.toString()).type)
        envelope.getJSONObject("payload").put("sequence", 0)
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(envelope.toString()) }
        envelope.getJSONObject("payload").put("sequence", 2).put("url", "https://example.org")
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(envelope.toString()) }
    }

    @Test fun oldWritersCannotOverwriteANewSessionOrANewerPublication() {
        val order = WidgetWriteOrder()
        order.begin("old")
        assertTrue(order.current("old", 3))
        order.committed("old", 3)
        assertFalse(order.current("old", 2))
        assertFalse(order.current("old", 3))
        order.begin("new")
        assertFalse(order.current("old", 100))
        assertTrue(order.current("new", 1))
        order.end("old")
        assertTrue(order.current("new", 1))
        order.end("new")
        assertFalse(order.current("new", 2))
    }

    private fun rowV2(id: String = "synthetic-task", date: String = "2026-10-26", priority: String = "normal") =
        row(id, date).put("priority", priority)

    private fun projectionV2(todayRows: Int = 1, total: Int = todayRows): JSONObject {
        val value = projection().put("version", 2)
        val days = value.getJSONArray("days")
        for (offset in 0..13) {
            val day = days.getJSONObject(offset)
            val rows = JSONArray()
            val count = if (offset == 0) todayRows else 1
            for (index in 0 until count) rows.put(rowV2(id = "task-$index", date = day.getString("date")))
            day.put("rows", rows).put("total", if (offset == 0) total else 1).put("completed", 0)
        }
        return value
    }

    @Test fun acceptsVersionTwoWithProgressAndPriorityAndKeepsVersionOne() {
        val value = projectionV2()
        value.getJSONArray("days").getJSONObject(0).put("completed", 3)
            .getJSONArray("rows").getJSONObject(0).put("priority", "high")
        val parsed = WidgetPolicy.parse(value.toString())
        assertEquals(2, parsed.version)
        assertEquals(3, parsed.days[0].completed)
        assertEquals("high", parsed.days[0].rows[0].priority)
        val legacy = WidgetPolicy.parse(projection().toString())
        assertEquals(1, legacy.version)
        assertNull(legacy.days[0].completed)
        assertEquals("normal", legacy.days[0].rows[0].priority)
    }

    @Test fun versionTwoKeysAndLimitsAreExact() {
        fun rejectsV2(change: (JSONObject) -> Unit) {
            val value = projectionV2()
            change(value)
            assertThrows(Exception::class.java) { WidgetPolicy.parse(value.toString()) }
        }
        rejectsV2 { it.put("version", 3) }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).remove("completed") }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).put("completed", -1) }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).put("completed", 1.5) }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).remove("priority") }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).getJSONArray("rows").getJSONObject(0).put("priority", "urgent") }
        rejectsV2 { it.getJSONArray("days").getJSONObject(0).put("rows", JSONArray()) }
        rejects { it.getJSONArray("days").getJSONObject(0).put("completed", 0) }
        assertEquals(50, WidgetPolicy.parse(projectionV2(50, 80).toString()).days[0].rows.size)
        assertThrows(Exception::class.java) { WidgetPolicy.parse(projectionV2(51, 80).toString()) }
        val later = projectionV2()
        val laterDay = later.getJSONArray("days").getJSONObject(1).put("total", 30)
        val laterRows = JSONArray()
        for (index in 0..19) laterRows.put(rowV2(id = "later-$index", date = laterDay.getString("date")))
        laterDay.put("rows", laterRows)
        assertEquals(20, WidgetPolicy.parse(later.toString()).days[1].rows.size)
        laterRows.put(rowV2(id = "later-20", date = laterDay.getString("date")))
        assertThrows(Exception::class.java) { WidgetPolicy.parse(later.toString()) }
        // Later days may be trimmed to fit the cache.
        laterDay.put("rows", JSONArray())
        assertEquals(30, WidgetPolicy.parse(later.toString()).days[1].total)
    }
}
