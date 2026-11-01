package app.valrecall.mobile

import java.time.LocalDate

/**
 * Today's outfit, shared with the desktop and the phone app: a fixed 12-day rotation keyed on the
 * local date. Only the index lives here; the wardrobe arrays in res/values map it to art, and the
 * public build points every slot at the neutral vectors.
 */
object WidgetWardrobe {
    const val ROTATION_SIZE = 12
    private val datePattern = Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")

    /** Position in the rotation for a `YYYY-MM-DD` key; a missing or invalid key gets the first. */
    fun outfitIndex(dateKey: String?): Int {
        if (dateKey == null || !datePattern.matches(dateKey)) return 0
        val date = try { LocalDate.parse(dateKey) } catch (_: RuntimeException) { return 0 }
        // Year 0 is invalid in wardrobe.ts too, so both sides fall back to the first outfit.
        if (date.year < 1) return 0
        return Math.floorMod(date.toEpochDay(), ROTATION_SIZE.toLong()).toInt()
    }
}
