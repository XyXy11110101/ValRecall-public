package app.valrecall.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.view.inputmethod.InputMethodManager
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var client: LanClient
    private lateinit var store: PairStore
    private val executor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(8))
    private val widgetExecutor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(8))
    private val widgetSession = UUID.randomUUID().toString()
    private lateinit var widgets: WidgetStore
    private val widgetNavigation = WidgetNavigation()
    private var keyboardPending = false
    private var pendingPermission: NativeRequest? = null
    private var pendingScan: NativeRequest? = null
    private val activeRequests = mutableSetOf<String>()
    private var networkRegistered = false
    private val localNetworkPermission = "android.permission.ACCESS_LOCAL_NETWORK"
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { notifyNetwork() }
        override fun onLost(network: Network) { notifyNetwork() }
    }

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        val request = pendingPermission
        pendingPermission = null
        if (request != null) {
            if (!networkAllowed() || (request.type == "pair.scan" && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)) {
                finishError(request.id, "PERMISSION_DENIED", "需要相机和本地网络权限，也可粘贴配对文字。")
            } else route(request)
        }
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val request = pendingScan
        pendingScan = null
        if (request != null) {
            if (result.contents == null) finishError(request.id, "CANCELLED", "已取消扫描。")
            else submit(request.id) { client.pair(result.contents) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        widgets = WidgetStore(this)
        widgets.begin(widgetSession)
        if (savedInstanceState != null) {
            savedInstanceState.getString("widgetNavigation")?.let {
                try { widgetNavigation.restore(it) } catch (_: Exception) { /* ignore a stale destination */ }
            }
        } else receiveWidgetIntent(intent)
        store = PairStore(this)
        client = LanClient(store)
        webView = WebView(this)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            setContentView(TextView(this).apply {
                setText(R.string.update_webview)
                setPadding(32, 64, 32, 32)
            })
            return
        }
        val container = FrameLayout(this)
        container.addView(webView, FrameLayout.LayoutParams(-1, -1))
        container.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        setContentView(container)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
        }
        WebView.setWebContentsDebuggingEnabled(false)
        CookieManager.getInstance().setAcceptCookie(false)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.isForMainFrame || !NativePolicy.trustedPage(request.url.toString())

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (!NativePolicy.localAsset(request.url.toString()) || request.method != "GET") return blocked()
                return loader.shouldInterceptRequest(request.url) ?: blocked()
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        }
        webView.setDownloadListener { _, _, _, _, _ -> /* no downloads or external applications */ }
        WebViewCompat.addWebMessageListener(webView, "ValRecallTransport", setOf(NativePolicy.ORIGIN)) { view, message, origin, mainFrame, _ ->
            if (!mainFrame || origin.toString() != NativePolicy.ORIGIN || !NativePolicy.trustedPage(view.url)) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            val request = try { NativePolicy.parseRequest(raw) } catch (_: Exception) { return@addWebMessageListener }
            if (activeRequests.contains(request.id)) return@addWebMessageListener
            if (activeRequests.size >= 10) { finishError(request.id, "BUSY", "正在处理请求，请稍后重试。"); return@addWebMessageListener }
            activeRequests.add(request.id)
            route(request)
        }
        WebViewCompat.addDocumentStartJavaScript(webView,
            "if(window===window.top){Object.defineProperty(window,'ValRecallNative',{value:Object.freeze({request:function(json){if(typeof json==='string')window.ValRecallTransport.postMessage(json);}}),writable:false,configurable:false});}",
            setOf(NativePolicy.ORIGIN))
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
        webView.loadUrl(NativePolicy.PAGE)
        try {
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
            networkRegistered = true
        } catch (_: RuntimeException) { /* resume still triggers sync readiness */ }
    }

    private fun route(request: NativeRequest) {
        if (request.type in setOf("pair.scan", "pair.import")) {
            val permissions = mutableListOf<String>()
            if (!networkAllowed()) permissions.add(localNetworkPermission)
            if (request.type == "pair.scan" && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) permissions.add(Manifest.permission.CAMERA)
            if (permissions.isNotEmpty()) {
                if (pendingPermission != null || pendingScan != null) { finishError(request.id, "BUSY", "已有配对操作进行中。"); return }
                pendingPermission = request
                permissionLauncher.launch(permissions.toTypedArray())
                return
            }
        }
        when (request.type) {
            "widget.publish" -> publishWidget(request)
            "navigation.consume" -> reply(JSONObject().put("id", request.id).put("ok", true)
                .put("payload", widgetNavigation.consume() ?: JSONObject.NULL))
            "navigation.inputReady" -> {
                if (!widgetNavigation.inputReady(request.payload.getString("id"))) {
                    finishError(request.id, "STALE_NAVIGATION", "该快捷输入已结束。")
                } else {
                    keyboardPending = true
                    webView.post { showWidgetKeyboard() }
                    reply(JSONObject().put("id", request.id).put("ok", true).put("payload", JSONObject()))
                }
            }
            "pair.scan" -> {
                if (pendingScan != null) { finishError(request.id, "BUSY", "已有扫描进行中。"); return }
                pendingScan = request
                scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("扫描电脑 ValRecall 的配对码")
                    .setBeepEnabled(false).setBarcodeImageEnabled(false).setOrientationLocked(false))
            }
            "pair.import" -> submit(request.id) { client.pair(request.payload.getString("qr")) }
            "pair.status" -> submit(request.id) { client.status() }
            "pair.forget" -> submit(request.id) { store.forget(); client.status() }
            "sync" -> {
                if (!networkAllowed()) finishError(request.id, "PERMISSION_DENIED", "本地网络权限未开启，请在系统设置中允许 ValRecall 访问本地网络。")
                else submit(request.id) { client.sync(request.payload) }
            }
        }
    }

    private fun networkAllowed(): Boolean = Build.VERSION.SDK_INT < 37 || checkSelfPermission(localNetworkPermission) == PackageManager.PERMISSION_GRANTED

    private fun publishWidget(request: NativeRequest) {
        val sequence = request.payload.getLong("sequence")
        val raw = request.payload.getJSONObject("projection").toString()
        try {
            widgetExecutor.execute {
                try {
                    if (widgets.publish(widgetSession, sequence, raw)) TodoWidgetProvider.refresh(applicationContext)
                    reply(JSONObject().put("id", request.id).put("ok", true).put("payload", JSONObject()))
                } catch (_: Exception) {
                    finishError(request.id, "WIDGET_UNAVAILABLE", "小组件没更新。")
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            finishError(request.id, "BUSY", "桌面小组件正在更新。")
        }
    }

    private fun receiveWidgetIntent(value: Intent?) {
        if (value?.action != WidgetNavigation.ACTION) return
        keyboardPending = false
        val raw = value.getStringExtra(WidgetNavigation.EXTRA) ?: return
        try { widgetNavigation.receive(raw) } catch (_: Exception) { return }
        // The intent is only a one-shot destination, never the WebView URL.
        value.removeExtra(WidgetNavigation.EXTRA)
        value.action = Intent.ACTION_MAIN
        value.data = null
        notifyPage("valrecall-navigation-ready")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveWidgetIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        widgetNavigation.save()?.let { outState.putString("widgetNavigation", it) }
        super.onSaveInstanceState(outState)
    }

    private fun showWidgetKeyboard() {
        if (!keyboardPending || !::webView.isInitialized || isDestroyed || !hasWindowFocus()) return
        keyboardPending = false
        webView.requestFocus()
        if (Build.VERSION.SDK_INT >= 30) window.insetsController?.show(WindowInsets.Type.ime())
        else {
            @Suppress("DEPRECATION")
            getSystemService(InputMethodManager::class.java).showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) showWidgetKeyboard()
    }

    private fun submit(id: String, operation: () -> JSONObject) {
        try {
            executor.execute {
                try { reply(JSONObject().put("id", id).put("ok", true).put("payload", operation())) }
                catch (error: LanFailure) { finishError(id, error.code, error.message) }
                catch (_: Exception) { finishError(id, "NATIVE_ERROR", "操作失败，请检查配对码和电脑同步后重试。") }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) { finishError(id, "BUSY", "正在处理请求，请稍后重试。") }
    }

    private fun finishError(id: String, code: String, message: String) {
        reply(JSONObject().put("id", id).put("ok", false).put("error", JSONObject().put("code", code).put("message", message)))
    }

    private fun reply(envelope: JSONObject) = runOnUiThread {
        activeRequests.remove(envelope.getString("id"))
        if (!isDestroyed && NativePolicy.trustedPage(webView.url)) {
            val detail = JSONObject.quote(envelope.toString())
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('valrecall-native-result',{detail:$detail}));", null)
        }
    }

    private fun notifyPage(event: String) = runOnUiThread {
        if (::webView.isInitialized && !isDestroyed && NativePolicy.trustedPage(webView.url))
            webView.evaluateJavascript("window.dispatchEvent(new Event('$event'));", null)
    }

    private fun notifyNetwork() {
        val online = getSystemService(ConnectivityManager::class.java).activeNetwork != null
        notifyPage(if (online) "valrecall-network-ready" else "valrecall-network-offline")
    }

    override fun onResume() { super.onResume(); notifyNetwork(); notifyPage("valrecall-app-resume") }
    override fun onPause() { keyboardPending = false; notifyPage("valrecall-app-background"); super.onPause() }
    override fun onDestroy() {
        if (networkRegistered) getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        executor.shutdownNow()
        widgets.end(widgetSession)
        widgetExecutor.shutdownNow()
        if (::webView.isInitialized) { webView.stopLoading(); webView.destroy() }
        super.onDestroy()
    }

    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
