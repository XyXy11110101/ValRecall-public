package app.valrecall.mobile

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** A disposable display cache; never the task database or an outbound mutation queue. */
class WidgetStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "todo-widget-v1.json"))

    fun begin(session: String) = synchronized(lock) { order.begin(session) }
    fun end(session: String) = synchronized(lock) { order.end(session) }

    fun publish(session: String, sequence: Long, raw: String): Boolean = synchronized(lock) {
        if (!order.current(session, sequence)) return false
        WidgetPolicy.parse(raw)
        val stream = file.startWrite()
        try {
            stream.write(raw.toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
            order.committed(session, sequence)
            true
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    fun read(): String? = synchronized(lock) {
        try {
            file.openRead().use { stream ->
                val buffer = ByteArray(8192)
                val output = ByteArrayOutputStream()
                while (output.size() <= WidgetPolicy.MAX_BYTES) {
                    val count = stream.read(buffer, 0, minOf(buffer.size, WidgetPolicy.MAX_BYTES + 1 - output.size()))
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                val bytes = output.toByteArray()
                if (bytes.size > WidgetPolicy.MAX_BYTES) "" else Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString()
            }
        } catch (_: java.io.FileNotFoundException) {
            null
        } catch (_: Exception) {
            // An unreadable cache is not an empty task list.
            ""
        }
    }

    companion object {
        private val lock = Any()
        private val order = WidgetWriteOrder()
    }
}
