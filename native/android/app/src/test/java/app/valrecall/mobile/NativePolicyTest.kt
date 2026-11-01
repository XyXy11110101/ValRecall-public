package app.valrecall.mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

class NativePolicyTest {
    @Test fun forwardsChangeCheckThroughExistingAuthenticatedSyncBridge() {
        val payload = JSONObject().put("version", 2).put("type", "change-state").put("epoch", "synthetic-epoch")
        val envelope = JSONObject().put("id", "check-content").put("type", "sync").put("payload", payload)
        val parsed = NativePolicy.parseRequest(envelope.toString())
        assertEquals("sync", parsed.type)
        assertEquals("change-state", parsed.payload.getString("type"))
        envelope.put("type", "change-state")
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(envelope.toString()) }
    }
    @Test fun forwardsV2CapabilitiesAndLifecycleInsideTheUnchangedNarrowBridge() {
        val capability = JSONObject().put("version", 2).put("type", "capabilities").put("epoch", "synthetic-epoch")
        val envelope = JSONObject().put("id", "v2-check").put("type", "sync").put("payload", capability)
        assertEquals(2, NativePolicy.parseRequest(envelope.toString()).payload.getInt("version"))
        listOf("undo-task", "archive-task", "skip-task", "restore-task").forEach { kind ->
            val op = JSONObject().put("id", "synthetic-op").put("kind", kind)
            val payload = JSONObject().put("version", 2).put("type", "push").put("epoch", "synthetic-epoch")
                .put("operations", org.json.JSONArray().put(op))
            envelope.put("payload", payload)
            assertEquals(kind, NativePolicy.parseRequest(envelope.toString()).payload.getJSONArray("operations").getJSONObject(0).getString("kind"))
        }
        // Domain validation is authoritative in Edge, not an expanded native interface.
        envelope.put("type", "undo-task")
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(envelope.toString()) }
    }

    @Test fun acceptsOnlyCanonicalPrivateIpv4() {
        listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.20").forEach { assertTrue(it, NativePolicy.privateIpv4(it)) }
        listOf("127.0.0.1", "169.254.1.1", "8.8.8.8", "172.32.1.1", "192.168.1.256", "192.168.01.1", "10.1.1.1.example.com", "::1", "2130706433", "10.1.1.1/path").forEach { assertFalse(it, NativePolicy.privateIpv4(it)) }
    }

    @Test fun bridgeTrustIsExactPageAndOrigin() {
        assertTrue(NativePolicy.trustedPage(NativePolicy.PAGE))
        listOf("tasks", "wallet", "settings", "add-task", "spend", "task-history").forEach {
            assertTrue(NativePolicy.trustedPage("${NativePolicy.PAGE}#$it"))
            assertFalse(NativePolicy.trustedPage("${NativePolicy.PAGE}?view=$it"))
        }
        listOf("http://appassets.androidplatform.net/assets/mobile.html", "${NativePolicy.PAGE}?url=bad", "https://appassets.androidplatform.net.evil/assets/mobile.html", "https://evil@appassets.androidplatform.net/assets/mobile.html", "https://appassets.androidplatform.net:444/assets/mobile.html", "https://appassets.androidplatform.net/assets/other.html", "file:///assets/mobile.html").forEach { assertFalse(it, NativePolicy.trustedPage(it)) }
    }

    @Test fun noRemoteOrTraversalAssets() {
        assertTrue(NativePolicy.localAsset("${NativePolicy.ORIGIN}/assets/assets/mobile-abc.js"))
        assertFalse(NativePolicy.localAsset("${NativePolicy.ORIGIN}/assets/../secret"))
        assertFalse(NativePolicy.localAsset("${NativePolicy.ORIGIN}/assets/%2e%2e/secret"))
        assertFalse(NativePolicy.localAsset("https://example.org/script.js"))
    }

    @Test fun exactPinRejectsWrongAndMalformedCertificates() {
        val bytes = "synthetic public certificate bytes".toByteArray()
        val pin = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertTrue(NativePolicy.matchesPin(bytes, pin))
        assertFalse(NativePolicy.matchesPin("other".toByteArray(), pin))
        assertFalse(NativePolicy.matchesPin(bytes, pin.uppercase()))
        assertFalse(NativePolicy.matchesPin(bytes, "00"))
    }

    private fun code(): JSONObject = JSONObject().put("version", 1).put("serverId", "synthetic-server")
        .put("host", "192.168.1.2").put("port", 19284).put("fingerprint", "0".repeat(64))
        .put("secret", Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32)))
        .put("expiresAt", "2026-10-13T12:05:00Z")

    @Test fun pairCodeValidatesExpirySizeKeysAndDestination() {
        val now = Instant.parse("2026-10-13T12:00:00Z")
        assertEquals("192.168.1.2", NativePolicy.parsePairCode(code().toString(), now).host)
        val invalid = listOf(code().put("host", "8.8.8.8"), code().put("port", 443), code().put("version", "1"), code().put("expiresAt", "2026-10-13T11:59:59Z"), code().put("expiresAt", "2026-10-13T13:00:00Z"), code().put("secret", "bad"), code().put("url", "https://example.com"))
        invalid.forEach { assertThrows(Exception::class.java) { NativePolicy.parsePairCode(it.toString(), now) } }
        assertThrows(Exception::class.java) { NativePolicy.parsePairCode("x".repeat(4097), now) }
    }

    @Test fun bridgeExposesOnlyNarrowCommands() {
        val status = """{"id":"req-1","type":"pair.status","payload":{}}"""
        assertEquals("pair.status", NativePolicy.parseRequest(status).type)
        listOf(status.replace("pair.status", "fetch"), status.replace("{}", "{\"url\":\"https://example.com\"}"), status.replace("req-1", "bad id"), "{}").forEach {
            assertThrows(Exception::class.java) { NativePolicy.parseRequest(it) }
        }
    }

    @Test fun bridgeBoundsSyncBatchAndTokenEncoding() {
        val request = JSONObject().put("id", "sync-1").put("type", "sync")
            .put("payload", JSONObject().put("operations", org.json.JSONArray(List(51) { JSONObject() })))
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(request.toString()) }
        val canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
        assertTrue(NativePolicy.validToken(canonical))
        assertFalse(NativePolicy.validToken(canonical + "="))
        assertFalse(NativePolicy.validToken(canonical.dropLast(1) + "B"))
    }

    @Test fun syncBoundsUtf8DomainPayloadSeparatelyFromNativeEnvelope() {
        val payload = JSONObject().put("text", "")
        val overhead = payload.toString().toByteArray(Charsets.UTF_8).size
        payload.put("text", "x".repeat(NativePolicy.MAX_SYNC_PAYLOAD_BYTES - overhead))
        val request = JSONObject().put("id", "sync-1").put("type", "sync").put("payload", payload)
        assertEquals("sync", NativePolicy.parseRequest(request.toString()).type)
        payload.put("text", "x".repeat(NativePolicy.MAX_SYNC_PAYLOAD_BYTES - overhead + 1))
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(request.toString()) }
        payload.put("text", "中".repeat(NativePolicy.MAX_SYNC_PAYLOAD_BYTES / 3 + 1))
        assertTrue(request.toString().length < NativePolicy.MAX_SYNC_PAYLOAD_BYTES)
        assertThrows(Exception::class.java) { NativePolicy.parseRequest(request.toString()) }
        assertEquals(512 * 1024, NativePolicy.MAX_REQUEST_BYTES)
        assertEquals(900_000, NativePolicy.MAX_RESPONSE_BYTES)
    }

    @Test fun syncReadWaitCoversHelperAndAllRetriesShareOneBoundedBudget() {
        var nanos = 0L
        val budget = NativeCallBudget(NativePolicy.SYNC_BUDGET_MILLIS) { nanos }
        assertEquals(100_000, budget.remainingMillis())
        assertEquals(10_000, budget.timeoutMillis(10_000))
        assertEquals(40_000, budget.timeoutMillis(NativePolicy.SYNC_READ_MILLIS))
        nanos = 35_000_000_000L
        assertEquals(65_000, budget.remainingMillis())
        assertEquals(40_000, budget.timeoutMillis(NativePolicy.SYNC_READ_MILLIS))
        nanos = 99_000_000_000L
        assertEquals(1_000, budget.timeoutMillis(10_000))
        assertEquals(1_000, budget.timeoutMillis(NativePolicy.SYNC_READ_MILLIS))
        nanos = 99_999_000_001L
        assertEquals(1, budget.timeoutMillis(NativePolicy.SYNC_READ_MILLIS))
        nanos = 100_000_000_000L
        assertEquals(0, budget.remainingMillis())
        assertThrows(java.net.SocketTimeoutException::class.java) { budget.timeoutMillis(10_000) }
        // Later retries cannot acquire a fresh timeout once this same budget expires.
        nanos += 5_000_000_000L
        assertThrows(java.net.SocketTimeoutException::class.java) { budget.timeoutMillis(40_000) }
    }

    @Test fun pairingRetainsShortBudgetAndInvalidDurationsCannotMeanUnlimited() {
        var nanos = 100L
        val budget = NativeCallBudget(NativePolicy.PAIR_BUDGET_MILLIS) { nanos }
        assertEquals(20_000, budget.remainingMillis())
        nanos += 19_500_000_000L
        assertEquals(500, budget.timeoutMillis(10_000))
        nanos += 500_000_000L
        assertThrows(java.net.SocketTimeoutException::class.java) { budget.timeoutMillis(10_000) }
        assertThrows(IllegalArgumentException::class.java) { NativeCallBudget(0) }
        assertThrows(IllegalArgumentException::class.java) { NativeCallBudget(20_000).timeoutMillis(0) }
    }
}
