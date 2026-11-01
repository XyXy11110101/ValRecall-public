package app.valrecall.mobile

import org.json.JSONObject
import java.net.URI
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

data class PairCode(
    val serverId: String,
    val host: String,
    val fingerprint: String,
    val secret: String,
    val expiresAt: Instant,
)

data class NativeRequest(val id: String, val type: String, val payload: JSONObject)

/** One monotonic deadline is shared by the original request, discovery and every fallback. */
class NativeCallBudget(durationMillis: Int, private val clock: () -> Long = System::nanoTime) {
    private val started = clock()
    private val durationNanos = durationMillis.toLong() * 1_000_000L
    init { require(durationMillis > 0) }

    fun remainingMillis(): Int {
        val remaining = durationNanos - (clock() - started).coerceAtLeast(0)
        return if (remaining <= 0) 0 else ((remaining + 999_999L) / 1_000_000L).toInt()
    }

    fun timeoutMillis(maximum: Int): Int {
        require(maximum > 0)
        val remaining = remainingMillis()
        if (remaining == 0) throw SocketTimeoutException("Native call budget expired")
        // A zero socket timeout means unlimited, so it must never be returned here.
        return minOf(maximum, remaining)
    }
}

/** Pure boundary rules: neither URLs nor generic network requests cross the bridge. */
object NativePolicy {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val PAGE = "$ORIGIN/assets/mobile.html"
    const val PORT = 19284
    const val MAX_SYNC_PAYLOAD_BYTES = 256 * 1024
    const val MAX_REQUEST_BYTES = 512 * 1024
    const val MAX_RESPONSE_BYTES = 900_000
    const val SYNC_BUDGET_MILLIS = 100_000
    const val PAIR_BUDGET_MILLIS = 20_000
    const val SYNC_READ_MILLIS = 40_000
    private val identifier = Regex("[A-Za-z0-9_-]{1,128}")
    private val fingerprintPattern = Regex("[0-9a-f]{64}")
    private val secretPattern = Regex("[A-Za-z0-9_-]{43}")
    private val types = setOf("pair.scan", "pair.import", "pair.status", "pair.forget", "sync", "widget.publish", "navigation.consume", "navigation.inputReady")

    fun privateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) }) return false
        val n = parts.map { it.toInt() }
        if (n.any { it !in 0..255 }) return false
        return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168)
    }

    fun trustedPage(url: String?): Boolean = try {
        val uri = URI(url ?: "")
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            uri.port == -1 && uri.rawUserInfo == null && uri.rawPath == "/assets/mobile.html" &&
            uri.rawQuery == null
    } catch (_: Exception) { false }

    fun localAsset(url: String): Boolean = try {
        val uri = URI(url)
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
            uri.port == -1 && uri.rawUserInfo == null && uri.rawPath.startsWith("/assets/") &&
            !uri.rawPath.contains("..") && !uri.rawPath.contains('%') && uri.rawQuery == null
    } catch (_: Exception) { false }

    fun validIdentifier(value: String): Boolean = identifier.matches(value)
    fun validToken(value: String): Boolean = secretPattern.matches(value) && try {
        val decoded = Base64.getUrlDecoder().decode(value)
        decoded.size == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == value
    } catch (_: IllegalArgumentException) { false }

    fun matchesPin(der: ByteArray, expected: String): Boolean {
        if (!fingerprintPattern.matches(expected)) return false
        val actual = MessageDigest.getInstance("SHA-256").digest(der)
        val desired = expected.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        return MessageDigest.isEqual(actual, desired)
    }

    fun parsePairCode(text: String, now: Instant = Instant.now()): PairCode {
        require(text.toByteArray(Charsets.UTF_8).size <= 4096) { "配对码太长。" }
        val json = JSONObject(text)
        require(json.keys().asSequence().toSet() == setOf("version", "serverId", "host", "port", "fingerprint", "secret", "expiresAt")) {
            "不是有效的 ValRecall 配对码。"
        }
        require(json.get("version") == 1 && json.get("port") == PORT) { "配对码版本不支持。" }
        val serverId = json.getString("serverId")
        val host = json.getString("host")
        val fingerprint = json.getString("fingerprint")
        val secret = json.getString("secret")
        val expires = Instant.parse(json.getString("expiresAt"))
        require(validIdentifier(serverId) && privateIpv4(host) && fingerprintPattern.matches(fingerprint) && validToken(secret)) {
            "配对码地址或身份无效。"
        }
        require(expires.isAfter(now) && !expires.isAfter(now.plusSeconds(600))) { "配对码已过期，请在电脑重新生成。" }
        return PairCode(serverId, host, fingerprint, secret, expires)
    }

    fun parseRequest(raw: String): NativeRequest {
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES) { "请求超过大小限制。" }
        val value = JSONObject(raw)
        require(value.keys().asSequence().toSet() == setOf("id", "type", "payload")) { "请求格式无效。" }
        val id = value.getString("id")
        val type = value.getString("type")
        require(validIdentifier(id) && type in types) { "请求类型无效。" }
        val payload = value.getJSONObject("payload")
        when (type) {
            "pair.scan", "pair.status", "pair.forget", "navigation.consume" -> require(payload.length() == 0)
            "widget.publish" -> WidgetPolicy.validatePublish(payload)
            "navigation.inputReady" -> {
                WidgetPolicy.keys(payload, setOf("id"))
                require(validIdentifier(WidgetPolicy.text(payload, "id")))
            }
            "pair.import" -> require(payload.keys().asSequence().toSet() == setOf("qr") && payload.get("qr") is String)
            "sync" -> {
                require(payload.toString().toByteArray(Charsets.UTF_8).size <= MAX_SYNC_PAYLOAD_BYTES) { "同步内容超过大小限制。" }
                val operations = payload.optJSONArray("operations")
                require(operations == null || operations.length() <= 50) { "一次最多同步 50 个操作。" }
            }
        }
        return NativeRequest(id, type, payload)
    }
}
