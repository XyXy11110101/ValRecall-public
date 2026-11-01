package app.valrecall.mobile

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.NetworkInterface
import java.net.Proxy
import java.net.URL
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Timer
import java.util.TimerTask
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.X509TrustManager

class LanFailure(val code: String, override val message: String) : IOException(message)

class LanClient(private val store: PairStore) {
    fun status(): JSONObject {
        val pair = store.load()
        return JSONObject().put("paired", pair != null).put("deviceId", store.deviceId()).apply {
            if (pair != null) put("epoch", pair.epoch)
        }
    }

    fun pair(qr: String): JSONObject {
        val budget = NativeCallBudget(NativePolicy.PAIR_BUDGET_MILLIS)
        val code = NativePolicy.parsePairCode(qr)
        val device = store.deviceId()
        val result = post(code.host, code.fingerprint, "/pair", null, budget,
            JSONObject().put("version", 1).put("serverId", code.serverId).put("secret", code.secret).put("deviceId", device))
        require(result.get("version") == 1 && result.getString("deviceId") == device &&
            NativePolicy.validToken(result.getString("token")) && NativePolicy.validIdentifier(result.getString("epoch"))) {
            "电脑返回的配对结果无效。"
        }
        store.save(PairIdentity(code.serverId, code.host, code.fingerprint, device, result.getString("token"), result.getString("epoch")))
        return status()
    }

    fun sync(payload: JSONObject): JSONObject {
        val budget = NativeCallBudget(NativePolicy.SYNC_BUDGET_MILLIS)
        require(payload.toString().toByteArray(Charsets.UTF_8).size <= NativePolicy.MAX_SYNC_PAYLOAD_BYTES)
        val pair = store.load() ?: throw LanFailure("NOT_PAIRED", "请先扫描电脑上的配对码。")
        val body = JSONObject().put("version", 1).put("deviceId", pair.deviceId).put("request", payload)
        var identityChanged = false
        try { return post(pair.host, pair.fingerprint, "/sync", pair.token, budget, body) }
        catch (error: LanFailure) {
            if (error.code !in setOf("UNREACHABLE", "CERTIFICATE_CHANGED")) throw error
            identityChanged = error.code == "CERTIFICATE_CHANGED"
        }
        val discovered = try { discover(pair.serverId, budget).filter { it != pair.host }.take(3) }
            catch (_: IOException) { emptyList() }
        for (host in discovered) {
            try {
                val result = post(host, pair.fingerprint, "/sync", pair.token, budget, body)
                store.save(pair.copy(host = host))
                return result
            } catch (error: LanFailure) {
                if (error.code != "UNREACHABLE" && error.code != "CERTIFICATE_CHANGED") throw error
                if (error.code == "CERTIFICATE_CHANGED") identityChanged = true
            }
        }
        if (identityChanged) throw LanFailure("CERTIFICATE_CHANGED", "电脑身份与配对记录不一致，请检查配对。")
        throw LanFailure("UNREACHABLE", "连不上电脑，请确认 Edge 已打开且在同一 Wi-Fi。")
    }

    private fun post(host: String, fingerprint: String, path: String, token: String?, budget: NativeCallBudget, body: JSONObject): JSONObject {
        if (budget.remainingMillis() == 0) throw LanFailure("UNREACHABLE", "同步超时，请重试。")
        require(NativePolicy.privateIpv4(host) && path in setOf("/pair", "/sync"))
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= NativePolicy.MAX_REQUEST_BYTES) { "同步内容超过大小限制。" }
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {
                throw CertificateException("Client trust is not supported")
            }
            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull() ?: throw CertificateException("Missing peer certificate")
                leaf.checkValidity()
                if (!NativePolicy.matchesPin(leaf.encoded, fingerprint)) throw CertificateException("Certificate pin differs")
            }
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        // LAN pairing must not use an Android/global HTTP proxy or contact a proxy service.
        val connection = (URL("https://$host:${NativePolicy.PORT}$path").openConnection(Proxy.NO_PROXY) as HttpsURLConnection)
        connection.sslSocketFactory = tls.socketFactory
        // A paired device can receive another DHCP address. The QR's exact certificate,
        // not an untrusted hostname or CA, is the authority for this one connection.
        connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { name, session ->
            name == host && NativePolicy.privateIpv4(name) && try {
                NativePolicy.matchesPin(session.peerCertificates.first().encoded, fingerprint)
            } catch (_: Exception) { false }
        }
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.requestMethod = "POST"
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.setRequestProperty("Accept", "application/json")
        if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(bytes.size)
        val timeout = Timer("ValRecall-native-deadline", true)
        try {
            // The watchdog also bounds blocked request writes or a slow TLS handshake.
            // It uses the SAME remaining call budget; fallback attempts never reset it.
            timeout.schedule(object : TimerTask() {
                override fun run() { connection.disconnect() }
            }, budget.timeoutMillis(Int.MAX_VALUE).toLong())
            connection.connectTimeout = budget.timeoutMillis(10_000)
            val readLimit = if (path == "/sync") NativePolicy.SYNC_READ_MILLIS else 10_000
            connection.readTimeout = budget.timeoutMillis(readLimit)
            connection.outputStream.use { it.write(bytes) }
            connection.readTimeout = budget.timeoutMillis(readLimit)
            val code = connection.responseCode
            if (code == 401 || code == 403) throw LanFailure("PAIRING_REVOKED", "配对已失效，请在电脑重新配对。")
            if (code !in 200..299) throw LanFailure("SERVER_REJECTED", "电脑拒绝了请求，请稍后重试。")
            if (connection.contentLengthLong > NativePolicy.MAX_RESPONSE_BYTES) throw LanFailure("RESPONSE_TOO_LARGE", "同步内容超过大小限制。")
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    connection.readTimeout = budget.timeoutMillis(readLimit)
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > NativePolicy.MAX_RESPONSE_BYTES) throw LanFailure("RESPONSE_TOO_LARGE", "同步内容超过大小限制。")
                    output.write(buffer, 0, count)
                }
            }
            budget.timeoutMillis(1)
            return JSONObject(output.toString("UTF-8"))
        } catch (error: LanFailure) { throw error }
        catch (_: SSLHandshakeException) { throw LanFailure("CERTIFICATE_CHANGED", "电脑身份与配对记录不一致，请重新配对。") }
        catch (_: IOException) { throw LanFailure("UNREACHABLE", "连接不到电脑，请确认处于同一 Wi-Fi。") }
        finally { timeout.cancel(); connection.disconnect() }
    }

    private fun discover(serverId: String, budget: NativeCallBudget): List<String> {
        budget.timeoutMillis(1)
        val request = JSONObject().put("version", 1).put("type", "discover").put("serverId", serverId).toString().toByteArray(Charsets.UTF_8)
        val hosts = linkedSetOf<String>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            val broadcasts = NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
                .flatMap { it.interfaceAddresses }.mapNotNull { it.broadcast }.distinct()
            for (address in broadcasts.take(8)) {
                budget.timeoutMillis(1)
                socket.send(DatagramPacket(request, request.size, address, NativePolicy.PORT))
            }
            val discoveryBudget = NativeCallBudget(minOf(1_500, budget.timeoutMillis(1_500)))
            while (discoveryBudget.remainingMillis() > 0 && budget.remainingMillis() > 0 && hosts.size < 8) {
                try {
                    socket.soTimeout = minOf(budget.timeoutMillis(350), discoveryBudget.timeoutMillis(350))
                    val response = DatagramPacket(ByteArray(2048), 2048)
                    socket.receive(response)
                    val host = response.address.hostAddress ?: continue
                    if (response.port != NativePolicy.PORT || !NativePolicy.privateIpv4(host)) continue
                    val value = JSONObject(String(response.data, 0, response.length, Charsets.UTF_8))
                    if (value.optInt("version") == 1 && value.optString("type") == "discovered" &&
                        value.optString("serverId") == serverId && value.optInt("port") == NativePolicy.PORT) hosts.add(host)
                } catch (_: java.net.SocketTimeoutException) { /* bounded receive window */ }
                catch (_: org.json.JSONException) { /* ignore unrelated LAN datagrams */ }
            }
        }
        return hosts.toList()
    }
}
