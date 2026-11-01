package app.valrecall.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.LocalDate

/** The widget wears the same outfit as the desktop and the phone app: wardrobe-manifest.json is the shared fixture. */
class WidgetWardrobeTest {
    private val manifest = JSONObject(
        File(System.getProperty("valrecall.wardrobeManifest") ?: "../../src/companion/wardrobe-manifest.json").readText(),
    )
    private fun strings(key: String): List<String> = manifest.getJSONArray(key).let { list -> (0 until list.length()).map { list.getString(it) } }
    private val rotation = strings("rotation")

    @Test fun everyManifestDateWearsTheManifestOutfit() {
        val cases: JSONArray = manifest.getJSONArray("dateCases")
        assertTrue(cases.length() > 0)
        (0 until cases.length()).map { cases.getJSONObject(it) }.forEach { case ->
            val date = case.getString("date")
            assertEquals(date, case.getLong("epochDay"), LocalDate.parse(date).toEpochDay())
            assertEquals(date, rotation.indexOf(case.getString("outfit")), WidgetWardrobe.outfitIndex(date))
        }
    }

    @Test fun rotationSizeAndPoseOrderMatchTheManifest() {
        assertEquals(rotation.size, WidgetWardrobe.ROTATION_SIZE)
        assertEquals(rotation.size, rotation.toSet().size)
        assertEquals(
            strings("widgetPoses").map { it.uppercase().replace('-', '_') },
            WidgetPose.values().map { it.name },
        )
    }

    @Test fun consecutiveDaysCycleThroughEveryOutfit() {
        val start = LocalDate.parse("2026-10-28")
        val indexes = (0L until 24L).map { WidgetWardrobe.outfitIndex(start.plusDays(it).toString()) }
        assertEquals((0 until WidgetWardrobe.ROTATION_SIZE).toSet(), indexes.take(12).toSet())
        assertEquals(indexes.take(12), indexes.drop(12))
        assertTrue(indexes.zipWithNext().none { (today, tomorrow) -> today == tomorrow })
    }

    @Test fun missingOrInvalidKeysWearTheFirstOutfit() {
        listOf(null, "", "2026-1-28", "26-10-28", "2026-13-01", "2026-02-30", "2026-10-28T00:00", "+12026-10-28", "0000-01-01")
            .forEach { assertEquals("$it", 0, WidgetWardrobe.outfitIndex(it)) }
    }

    @Test fun mainCodeNamesNoOutfit() {
        val sources = File("src/main").walkTopDown().filter { it.isFile && it.extension in setOf("kt", "xml") }.toList()
        assertTrue(sources.isNotEmpty())
        sources.forEach { source ->
            val text = source.readText()
            rotation.forEach { outfit -> assertFalse("${source.name}: $outfit", text.contains("\"$outfit\"") || text.contains("_${outfit}_")) }
        }
    }
}
