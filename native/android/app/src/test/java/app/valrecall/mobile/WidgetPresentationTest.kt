package app.valrecall.mobile

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class WidgetPresentationTest {
    private val today = "2026-10-27"
    private fun row(id: String, date: String = today, time: String? = null, priority: String = "normal", pending: Boolean = false) =
        WidgetRow(id, date, "任务 $id", time, pending, priority)

    private fun display(day: WidgetDay?, status: String = "ready", version: Int = 2): WidgetDisplay {
        val projection = WidgetProjection("ready", null, "epoch-1", "Europe/London", "2026-10-27T07:00:00Z",
            "2026-10-27T06:00:00Z", listOfNotNull(day), version)
        return WidgetDisplay(projection, day, status, today)
    }

    @Test fun eachStateHasItsPoseAndShortBubble() {
        val tasks = WidgetPresentation.model(display(WidgetDay(today, 3, 1, listOf(row("a"), row("b"), row("c", "2026-10-25")), null, 2)))
        assertEquals(WidgetMode.TASKS, tasks.mode)
        assertEquals(WidgetPose.HEAD_TALK, tasks.head)
        assertNull(tasks.hero)
        assertEquals("还有 3 项", tasks.bubble)
        assertEquals("2/5", tasks.progress!!.label)
        assertEquals(40, tasks.progress!!.percent)

        val done = WidgetPresentation.model(display(WidgetDay(today, 0, 0, emptyList(), null, 4)))
        assertEquals(WidgetMode.ALL_DONE, done.mode)
        assertEquals(WidgetPose.HEAD_JOY, done.head)
        assertEquals(WidgetPose.PEACE, done.hero)
        assertEquals("都完成啦！", done.bubble)

        val next = WidgetPresentation.model(display(WidgetDay(today, 0, 0, emptyList(), row("n", "2026-10-30"), 0)))
        assertEquals(WidgetMode.NEXT_ONLY, next.mode)
        assertEquals(WidgetPose.HEAD_SMILE, next.head)
        assertEquals(WidgetPose.CALM, next.hero)
        assertEquals("下一项 · 10/30 周五", next.next!!.meta)

        val empty = WidgetPresentation.model(display(WidgetDay(today, 0, 0, emptyList(), null, 0)))
        assertEquals(WidgetMode.EMPTY, empty.mode)
        assertEquals(WidgetPose.HEAD_SMILE, empty.head)
        assertEquals(WidgetPose.SLEEPY, empty.hero)
        assertEquals("今天没有安排", empty.bubble)

        mapOf("not-ready" to WidgetMode.NOT_READY, "read-error" to WidgetMode.READ_ERROR,
            "workspace-changed" to WidgetMode.WORKSPACE_CHANGED, "expired" to WidgetMode.EXPIRED).forEach { (status, mode) ->
            val problem = WidgetPresentation.model(WidgetDisplay(null, null, status, null))
            assertEquals(mode, problem.mode)
            assertEquals(WidgetPose.HEAD_WORRIED, problem.head)
            assertEquals(WidgetPose.HEAD_WORRIED, problem.hero)
            assertNotNull(problem.emptyHint)
        }
    }

    @Test fun theDateChoosesTheOutfitInEveryState() {
        val unused = { fail("the display already has a date"); "" }
        // 2026-10-27 is epoch day 20753, slot 5 of the 12-day rotation.
        listOf(
            WidgetDay(today, 3, 0, listOf(row("a")), null, 0),
            WidgetDay(today, 0, 0, emptyList(), null, 2),
            WidgetDay(today, 0, 0, emptyList(), row("n", "2026-10-30"), 0),
            WidgetDay(today, 0, 0, emptyList(), null, 0),
        ).forEach { assertEquals(5, WidgetPresentation.model(display(it), fallbackDate = unused).outfit) }
        val expired = WidgetPresentation.model(WidgetDisplay(null, null, "expired", "2026-10-28"), fallbackDate = unused)
        assertEquals(WidgetPose.HEAD_WORRIED, expired.head)
        assertEquals(6, expired.outfit)
    }

    @Test fun problemsWithoutADateUseTheFallbackDate() {
        listOf("not-ready", "read-error").forEach { status ->
            val problem = WidgetPresentation.model(WidgetDisplay(null, null, status, null), fallbackDate = { "2026-10-29" })
            assertEquals(WidgetPose.HEAD_WORRIED, problem.head)
            assertEquals(WidgetPose.HEAD_WORRIED, problem.hero)
            assertEquals(7, problem.outfit)
        }
        val at = Instant.parse("2026-10-27T17:00:00Z")
        assertEquals("2026-10-28", WidgetPresentation.systemDate("Asia/Shanghai", at))
        assertEquals("2026-10-27", WidgetPresentation.systemDate("Europe/London", at))
        val local = at.atZone(ZoneId.systemDefault()).toLocalDate().toString()
        assertEquals(local, WidgetPresentation.systemDate(null, at))
        assertEquals(local, WidgetPresentation.systemDate("Not/AZone", at))
    }

    @Test fun overdueAndTodayRowsKeepPhoneOrderAndFactualMeta() {
        val model = WidgetPresentation.model(display(WidgetDay(today, 3, 1, listOf(
            row("a", time = "08:00", priority = "high", pending = true), row("b", priority = "low"), row("late", "2026-10-25"),
        ), null, 0)))
        assertEquals(listOf("今天 · 08:00 · 优先 · 待同步", "今天 · 稍后", "逾期 10/25"), model.rows.map { it.meta })
        assertEquals(listOf(false, false, true), model.rows.map { it.overdue })
        // Tapping only opens a task, so nothing may promise to complete it.
        assertTrue(model.rows.none { it.description.contains("完成") })
        model.rows.forEach { WidgetNavigation.parseTarget(it.target.json().toString()) }
    }

    @Test fun versionOneCacheHasNoProgressAndLongListsOfferTheRest() {
        val legacy = WidgetPresentation.model(display(WidgetDay(today, 7, 0, (1..5).map { row("t$it") }, null, null), version = 1))
        assertNull(legacy.progress)
        assertEquals("7 项", legacy.countLabel)
        assertEquals(2, legacy.moreCount)
        val many = WidgetPresentation.model(display(WidgetDay(today, 60, 0, (1..50).map { row("t$it") }, null, 0)), limit = 50)
        assertEquals(50, many.rows.size)
        assertEquals(10, many.moreCount)
    }

    @Test fun labelsIdsAndSizes() {
        assertEquals("10月27日 周二", WidgetPresentation.dateLabel("2026-10-27"))
        val first = WidgetPresentation.stableId("task", "2026-10-27")
        assertEquals(first, WidgetPresentation.stableId("task", "2026-10-27"))
        assertNotEquals(first, WidgetPresentation.stableId("task", "2026-10-28"))
        assertNotEquals(WidgetPresentation.MORE_ITEM_ID, first)
        assertEquals(WidgetSize.COMPACT, WidgetPresentation.sizeFor(110f, 110f))
        assertEquals(WidgetSize.MEDIUM, WidgetPresentation.sizeFor(300f, 150f))
        assertEquals(WidgetSize.LARGE, WidgetPresentation.sizeFor(300f, 300f))
        assertTrue(WidgetPresentation.staticCapacity(400, 2f) < WidgetPresentation.staticCapacity(400, 1f))
        assertEquals(1, WidgetPresentation.staticCapacity(120, 1f))
        assertEquals(
            Instant.parse("2026-10-26T00:01:00Z"),
            WidgetPresentation.nextDayBoundary(Instant.parse("2026-10-24T23:30:00Z"), ZoneId.of("Europe/London")),
        )
    }
}
