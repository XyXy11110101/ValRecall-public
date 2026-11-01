package app.valrecall.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class PairIdentity(
    val serverId: String, val host: String, val fingerprint: String,
    val deviceId: String, val token: String, val epoch: String,
)

/** Pair credentials never enter WebView, Android backup, logs or plain-text preferences. */
class PairStore(context: Context) {
    private val pairFile = AtomicFile(File(context.noBackupFilesDir, "paired-device.bin"))
    private val deviceFile = AtomicFile(File(context.noBackupFilesDir, "device-id"))
    private val keyAlias = "valrecall-pairing-v1"

    @Synchronized fun deviceId(): String {
        if (deviceFile.baseFile.exists()) return deviceFile.readFully().toString(Charsets.UTF_8).also {
            require(UUID.fromString(it).toString() == it) { "本机标识无法读取。" }
        }
        val created = UUID.randomUUID().toString()
        atomicWrite(deviceFile, created.toByteArray(Charsets.UTF_8))
        return created
    }

    @Synchronized fun load(): PairIdentity? {
        if (!pairFile.baseFile.exists()) return null
        val bytes = pairFile.readFully()
        require(bytes.size in 29..8192 && bytes[0] == 1.toByte()) { "配对记录无法读取，请重新配对。" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        val value = JSONObject(cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8))
        val identity = PairIdentity(value.getString("serverId"), value.getString("host"),
            value.getString("fingerprint"), value.getString("deviceId"), value.getString("token"), value.getString("epoch"))
        require(NativePolicy.privateIpv4(identity.host) && NativePolicy.validToken(identity.token) && identity.deviceId == deviceId())
        return identity
    }

    @Synchronized fun save(identity: PairIdentity) {
        val text = JSONObject().put("serverId", identity.serverId).put("host", identity.host)
            .put("fingerprint", identity.fingerprint).put("deviceId", identity.deviceId)
            .put("token", identity.token).put("epoch", identity.epoch).toString()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        atomicWrite(pairFile, byteArrayOf(1) + cipher.iv + cipher.doFinal(text.toByteArray(Charsets.UTF_8)))
    }

    @Synchronized fun forget() { pairFile.delete() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun atomicWrite(file: AtomicFile, bytes: ByteArray) {
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
}
