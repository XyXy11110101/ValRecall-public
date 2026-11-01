import groovy.json.JsonSlurper
import java.security.MessageDigest
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

plugins { id("com.android.application") }

val stagedRoot = System.getenv("VALRECALL_ANDROID_BUILD_ROOT")
if (stagedRoot != null) {
    val target = file(stagedRoot).canonicalFile
    val allowed = rootProject.file("../../build").canonicalFile
    check(target.toPath().startsWith(allowed.toPath()) && target != allowed) {
        "Android staged output must be a child of build/."
    }
    layout.buildDirectory.set(target.resolve("app"))
}

val mobileAssets = rootProject.file(System.getenv("VALRECALL_MOBILE_ASSETS") ?: "../../build/mobile-web").canonicalFile
check(mobileAssets.toPath().startsWith(rootProject.file("../../build").canonicalFile.toPath()))

// The wardrobe contract shared with the web app: rotation order and the widget and phone poses.
val wardrobeManifest = rootProject.file("../../src/companion/wardrobe-manifest.json").canonicalFile

/** `<array name>` to its `<item>` values, for the widget wardrobe resource files. */
fun wardrobeArrays(source: File): Map<String, List<String>> {
    val factory = DocumentBuilderFactory.newInstance().apply {
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        isExpandEntityReferences = false
    }
    fun children(parent: Element): List<Element> =
        (0 until parent.childNodes.length).map { parent.childNodes.item(it) }.filterIsInstance<Element>()
    val root = factory.newDocumentBuilder().parse(source).documentElement
    check(root.tagName == "resources") { "${source.name} must hold only wardrobe arrays." }
    val arrays = linkedMapOf<String, List<String>>()
    children(root).forEach { array ->
        check(array.tagName == "array" && array.attributes.length == 1 && array.hasAttribute("name")) {
            "${source.name} must hold only named wardrobe arrays."
        }
        val items = children(array).map { item ->
            check(item.tagName == "item" && item.attributes.length == 0) { "${source.name} has an invalid array item." }
            item.textContent.trim()
        }
        check(arrays.put(array.getAttribute("name"), items) == null) { "${source.name} repeats an array." }
    }
    return arrays
}

// Private art is a release-only overlay under the gitignored build/ folder. The art and the tool
// that makes it are not in this repository. The overlay holds widget PNGs with the wardrobe arrays
// that point at them (res/), and the phone app's companion subset (web/). Its file set comes from
// the wardrobe manifest, and every byte must match the recorded SHA-256 list.
val widgetArt = System.getenv("VALRECALL_ANDROID_WIDGET_ART")?.let { file(it).canonicalFile }
if (widgetArt != null) {
    val buildRoot = rootProject.file("../../build").canonicalFile
    check(widgetArt.toPath().startsWith(buildRoot.toPath()) && widgetArt != buildRoot) {
        "Private widget art must be generated under build/."
    }
    val manifest = JsonSlurper().parse(wardrobeManifest) as Map<*, *>
    fun list(key: String): List<String> = (manifest[key] as List<*>).map { it as String }
    val rotation = list("rotation")
    val widgetPoses = list("widgetPoses")
    val staticOnly = list("staticOnlyPoses").toSet()
    val artRoot = manifest["artRoot"] as String
    fun resource(pose: String) = pose.replace('-', '_')
    val arraysPath = "res/values/widget_wardrobe.xml"
    val names = buildSet {
        add(arraysPath)
        rotation.forEach { outfit ->
            widgetPoses.forEach { add("res/drawable-nodpi/widget_art_${outfit}_${resource(it)}.png") }
            list("phonePoses").forEach { pose ->
                add("web/$artRoot/$outfit/$pose.svg")
                if (pose !in staticOnly) add("web/$artRoot/$outfit/$pose.anim.svg")
            }
        }
    }
    fun sha256(file: File): String = MessageDigest.getInstance("SHA-256")
        .digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    val lines = widgetArt.resolve("widget-art.sha256").readLines().filter { it.isNotBlank() }
    check(lines.all { Regex("[0-9a-f]{64}  [^ ].*").matches(it) }) { "Private widget art hash list is malformed." }
    val expected = lines.associate { it.substringAfter("  ") to it.substringBefore("  ") }
    check(expected.size == lines.size) { "Private widget art hash list repeats a file." }
    val actual = listOf("res", "web").flatMap { root -> widgetArt.resolve(root).walkTopDown().filter { it.isFile }.toList() }
        .associate { it.relativeTo(widgetArt).invariantSeparatorsPath to sha256(it) }
    check(actual.keys == names) { "Private widget art does not match the wardrobe manifest." }
    check(actual == expected) { "Private widget art does not match its hash list." }
    // The overlay replaces the public arrays one for one: same names, one slot per outfit in order.
    val publicArrays = wardrobeArrays(file("src/main/res/values/widget_wardrobe.xml"))
    val privateArrays = widgetPoses.associate { pose ->
        "widget_wardrobe_${resource(pose)}" to rotation.map { "@drawable/widget_art_${it}_${resource(pose)}" }
    }
    check(publicArrays.keys == privateArrays.keys && publicArrays.values.all { it.size == rotation.size }) {
        "The public wardrobe arrays do not match the wardrobe manifest."
    }
    check(wardrobeArrays(widgetArt.resolve(arraysPath)) == privateArrays) {
        "Private wardrobe arrays do not match the wardrobe manifest."
    }
    // Keep the art out of the shared Gradle build cache in the toolchain folder.
    tasks.configureEach { outputs.doNotCacheIf("Private widget art stays out of the build cache") { true } }
}

android {
    namespace = "app.valrecall.mobile"
    compileSdk = 37
    defaultConfig {
        applicationId = "app.valrecall.mobile"
        minSdk = 26
        targetSdk = 37
        versionCode = 16
        versionName = "0.81.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].assets.srcDir(mobileAssets)
    if (widgetArt != null) {
        sourceSets["release"].res.srcDir(widgetArt.resolve("res"))
        // The phone subset lands at assets/assets/companion/chibi/, beside the mobile web app.
        sourceSets["release"].assets.srcDir(widgetArt.resolve("web"))
    }
    signingConfigs {
        create("privateRelease") {
            val keyPath = System.getenv("VALRECALL_ANDROID_KEYSTORE")
            if (keyPath != null) {
                storeFile = file(keyPath)
                storePassword = System.getenv("VALRECALL_ANDROID_STORE_PASSWORD")
                keyAlias = "valrecall"
                keyPassword = System.getenv("VALRECALL_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Keep the verified widget art bytes exactly as rendered.
            isCrunchPngs = false
            signingConfig = signingConfigs.getByName("privateRelease")
        }
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}

tasks.register("verifyMobileAssets") {
    doLast {
        val mobileHtml = mobileAssets.resolve("mobile.html")
        check(mobileHtml.isFile) { "Build the real mobile web app before packaging Android." }
        check(!mobileHtml.readText().contains("VALRECALL_SMOKE_PLACEHOLDER")) {
            "A smoke placeholder must never be packaged as the mobile app."
        }
        // Companion art reaches the APK only through the hash-checked private overlay.
        check(!mobileAssets.resolve("assets/companion").exists()) {
            "The mobile web build must not carry companion art itself."
        }
        val showsArt = mobileAssets.walkTopDown().filter { it.isFile && it.extension == "js" }
            .any { it.readText().contains("assets/companion/chibi/") }
        check(!showsArt || widgetArt != null) {
            "This mobile build shows companion art; package it with the private overlay (VALRECALL_ANDROID_WIDGET_ART)."
        }
        check(showsArt || widgetArt == null) {
            "The private overlay needs the private mobile build, which shows its companion art."
        }
    }
}
tasks.named("preBuild").configure { dependsOn("verifyMobileAssets") }
// The JVM tests read the manifest and the resource files from disk, so both are test inputs and a
// cached result never outlives a change to either.
tasks.withType<Test>().configureEach {
    inputs.file(wardrobeManifest).withPropertyName("wardrobeManifest").withPathSensitivity(PathSensitivity.NONE)
    inputs.dir("src/main/res").withPropertyName("mainResources").withPathSensitivity(PathSensitivity.RELATIVE)
    systemProperty("valrecall.wardrobeManifest", wardrobeManifest.path)
}
tasks.matching { it.name == "validateSigningRelease" }.configureEach {
    doFirst {
        check(System.getenv("VALRECALL_ANDROID_KEYSTORE") != null) {
            "Release signing requires the persistent private key outside the repository."
        }
    }
}
