package app.valrecall.mobile

import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** The public source tree ships neutral vectors; private art only arrives as a release overlay. */
class WidgetResourcesTest {
    private val main = File("src/main")
    private val allowedViews = setOf("LinearLayout", "FrameLayout", "TextView", "ImageView", "ProgressBar", "ListView", "include", "merge")

    @Test fun everyPoseHasAPublicVectorFallback() {
        WidgetPose.values().forEach { pose ->
            val file = File(main, "res/drawable/widget_pose_${pose.name.lowercase()}.xml")
            assertTrue(file.path, file.isFile)
            assertTrue(file.path, file.readText().contains("<vector"))
        }
    }

    @Test fun everyWardrobeSlotPointsAtThePoseVector() {
        val root = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File(main, "res/values/widget_wardrobe.xml")).documentElement
        assertEquals("resources", root.tagName)
        val arrays = elements(root)
        assertTrue(arrays.all { it.tagName == "array" })
        assertEquals(WidgetPose.values().map { "widget_wardrobe_${it.name.lowercase()}" }, arrays.map { it.getAttribute("name") })
        WidgetPose.values().zip(arrays).forEach { (pose, array) ->
            val items = elements(array)
            assertEquals(pose.name, WidgetWardrobe.ROTATION_SIZE, items.size)
            items.forEach { item ->
                assertEquals("item", item.tagName)
                assertEquals("@drawable/widget_pose_${pose.name.lowercase()}", item.textContent.trim())
            }
        }
    }

    @Test fun layoutDefaultsUseExistingPoseVectors() {
        val references = File(main, "res/layout").listFiles()!!.flatMap { layout ->
            Regex("@drawable/(widget_pose_[a-z_]+)").findAll(layout.readText()).map { it.groupValues[1] }.toList()
        }
        assertTrue(references.isNotEmpty())
        references.forEach { assertTrue(it, File(main, "res/drawable/$it.xml").isFile) }
        val vectors = File(main, "res/drawable").list()!!.filter { it.startsWith("widget_pose_") }.toSet()
        assertEquals(WidgetPose.values().map { "widget_pose_${it.name.lowercase()}.xml" }.toSet(), vectors)
    }

    @Test fun noRasterArtOrPrivateNamesInTheSourceTree() {
        val files = main.walkTopDown().filter { it.isFile }.toList()
        assertTrue(files.isNotEmpty())
        assertTrue(files.none { it.extension.lowercase() in setOf("png", "jpg", "jpeg", "webp", "gif") })
        assertTrue(files.none { it.readText().contains("widget_art_") })
    }

    @Test fun widgetLayoutsUseOnlyRemoteViewsSafeViews() {
        val layouts = File(main, "res/layout").listFiles { file -> file.name.startsWith("todo_widget") }!!
        assertTrue(layouts.size >= 8)
        layouts.forEach { layout ->
            val tags = Regex("<([A-Za-z][A-Za-z0-9.]*)").findAll(layout.readText()).map { it.groupValues[1] }
                .filterNot { it == "xml" }.toSet()
            assertTrue("${layout.name}: $tags", allowedViews.containsAll(tags))
        }
        assertFalse(File(main, "res/layout/todo_widget_preview.xml").readText().contains("ListView"))
    }

    private fun elements(parent: Element): List<Element> =
        (0 until parent.childNodes.length).map { parent.childNodes.item(it) }.filterIsInstance<Element>()
}
