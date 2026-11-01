package app.valrecall.mobile

import org.json.JSONObject
import java.util.UUID

data class WidgetTarget(val kind: String, val epoch: String? = null, val taskId: String? = null, val occurrenceDate: String? = null) {
    fun json(): JSONObject = JSONObject().put("version", 1).put("kind", kind)
        .put("epoch", epoch ?: JSONObject.NULL).put("taskId", taskId ?: JSONObject.NULL)
        .put("occurrenceDate", occurrenceDate ?: JSONObject.NULL)
}

/** One pending navigation, no task writes and no arbitrary WebView destinations. */
class WidgetNavigation {
    private var pending: JSONObject? = null
    private var inputId: String? = null

    fun receive(raw: String) {
        val target = parseTarget(raw)
        pending = target.json().put("id", UUID.randomUUID().toString())
        inputId = null
    }

    fun consume(): JSONObject? {
        val next = pending
        pending = null
        if (next != null) inputId = if (next.getString("kind") == "add-task") next.getString("id") else null
        return next
    }

    fun inputReady(id: String): Boolean {
        if (id != inputId) return false
        inputId = null
        return true
    }

    fun save(): String? = pending?.toString()

    fun restore(raw: String) {
        val value = JSONObject(raw)
        WidgetPolicy.keys(value, setOf("version", "id", "kind", "epoch", "taskId", "occurrenceDate"))
        require(NativePolicy.validIdentifier(WidgetPolicy.text(value, "id")))
        val copy = JSONObject(value.toString()).apply { remove("id") }
        parseTarget(copy.toString())
        pending = value
        inputId = null
    }

    companion object {
        const val ACTION = "app.valrecall.mobile.OPEN_WIDGET"
        const val EXTRA = "app.valrecall.mobile.WIDGET_TARGET"

        fun parseTarget(raw: String): WidgetTarget {
            // A valid 512-unit identity can require six JSON bytes per escaped code unit.
            require(raw.toByteArray(Charsets.UTF_8).size <= 4096)
            val value = JSONObject(raw)
            WidgetPolicy.keys(value, setOf("version", "kind", "epoch", "taskId", "occurrenceDate"))
            require(WidgetPolicy.integer(value, "version", 1) == 1L)
            val kind = WidgetPolicy.text(value, "kind")
            require(kind in setOf("tasks", "task", "add-task"))
            fun optional(name: String): String? = if (value.get(name) === JSONObject.NULL) null else WidgetPolicy.text(value, name)
            val epoch = optional("epoch")
            val taskId = optional("taskId")
            val date = optional("occurrenceDate")
            if (kind == "task") {
                require(epoch != null && NativePolicy.validIdentifier(epoch))
                require(taskId != null && WidgetPolicy.validTaskId(taskId))
                require(date != null)
                WidgetPolicy.date(date)
            } else require(epoch == null && taskId == null && date == null)
            return WidgetTarget(kind, epoch, taskId, date)
        }
    }
}
