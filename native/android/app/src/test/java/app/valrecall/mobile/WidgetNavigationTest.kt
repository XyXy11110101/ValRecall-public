package app.valrecall.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WidgetNavigationTest {
    @Test fun coldLaunchConsumesOnceAndInputHandshakeCannotBeReused() {
        val navigation = WidgetNavigation()
        navigation.receive(WidgetTarget("add-task").json().toString())
        val target = navigation.consume()!!
        assertEquals("add-task", target.getString("kind"))
        assertNull(navigation.consume())
        assertFalse(navigation.inputReady("wrong-id"))
        assertTrue(navigation.inputReady(target.getString("id")))
        assertFalse(navigation.inputReady(target.getString("id")))
    }

    @Test fun aNewTapSupersedesOlderNavigationWithoutRepeatingItsKeyboard() {
        val navigation = WidgetNavigation()
        navigation.receive(WidgetTarget("add-task").json().toString())
        val previous = navigation.consume()!!.getString("id")
        navigation.receive(WidgetTarget("task", "epoch", "task", "2026-10-26").json().toString())
        assertFalse(navigation.inputReady(previous))
        val current = navigation.consume()!!
        assertEquals("task", current.getString("kind"))
        assertFalse(navigation.inputReady(current.getString("id")))
    }

    @Test fun pendingNavigationSurvivesRecreationButConsumedNavigationDoesNot() {
        val first = WidgetNavigation()
        first.receive(WidgetTarget("tasks").json().toString())
        val restored = WidgetNavigation()
        restored.restore(first.save()!!)
        assertEquals("tasks", restored.consume()!!.getString("kind"))
        assertNull(restored.save())
    }

    @Test fun repeatedClicksCreateFreshOneShotDestinations() {
        val navigation = WidgetNavigation()
        val raw = WidgetTarget("add-task").json().toString()
        navigation.receive(raw)
        val first = navigation.consume()!!.getString("id")
        navigation.receive(raw)
        val second = navigation.consume()!!.getString("id")
        assertNotEquals(first, second)
        assertFalse(navigation.inputReady(first))
        assertTrue(navigation.inputReady(second))
    }

    @Test fun opaqueTaskIdentitySurvivesNavigationWithoutBecomingAPathOrCommand() {
        val opaqueId = "任务:本周/复习:" + "中".repeat(503)
        assertEquals(512, opaqueId.length)
        val navigation = WidgetNavigation()
        navigation.receive(WidgetTarget("task", "epoch", opaqueId, "2026-10-26").json().toString())
        assertEquals(opaqueId, navigation.consume()!!.getString("taskId"))
        val escapedId = "任务:" + "\u0000".repeat(509)
        navigation.receive(WidgetTarget("task", "epoch", escapedId, "2026-10-26").json().toString())
        assertEquals(escapedId, navigation.consume()!!.getString("taskId"))
        assertThrows(Exception::class.java) {
            WidgetNavigation.parseTarget(WidgetTarget("task", "epoch", opaqueId + "中", "2026-10-26").json().toString())
        }
        assertThrows(Exception::class.java) {
            WidgetNavigation.parseTarget(WidgetTarget("task", "epoch", "   ", "2026-10-26").json().toString())
        }
    }

    @Test fun rejectsArbitraryCommandsIncompleteTargetsAndExtraFields() {
        val invalid = listOf(
            WidgetTarget("complete-task").json(),
            WidgetTarget("task").json(),
            WidgetTarget("add-task", "epoch").json(),
            WidgetTarget("task", "epoch", "task", "2026-02-30").json(),
            WidgetTarget("tasks").json().put("url", "https://example.org"),
            WidgetTarget("tasks").json().put("version", "1"),
        )
        invalid.forEach { value ->
            assertThrows(Exception::class.java) { WidgetNavigation.parseTarget(value.toString()) }
        }
    }

    @Test fun bridgeOnlyExposesConsumeAndOneShotInputAcknowledgement() {
        val request = JSONObject().put("id", "request").put("type", "navigation.consume").put("payload", JSONObject())
        assertEquals("navigation.consume", NativePolicy.parseRequest(request.toString()).type)
        request.getJSONObject("payload").put("target", "wallet")
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(request.toString()) }
        request.put("type", "navigation.inputReady").put("payload", JSONObject().put("id", "one-shot"))
        assertEquals("navigation.inputReady", NativePolicy.parseRequest(request.toString()).type)
        request.getJSONObject("payload").put("command", "anything")
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(request.toString()) }
    }
}
