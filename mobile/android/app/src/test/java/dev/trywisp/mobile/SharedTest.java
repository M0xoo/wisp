package dev.trywisp.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** What the share sheet may hand wisp: the rest needs a phone (MOB-33). */
public class SharedTest {
    private static final String ME = "dev.trywisp.mobile";

    @Test
    public void onlyAnotherAppsContentIsRead() {
        assertTrue(Shared.foreign("content", "com.google.android.apps.photos.contentprovider", ME));
        assertFalse("a path on the phone", Shared.foreign("file", null, ME));
        assertFalse("wisp's own provider", Shared.foreign("content", ME + ".fileprovider", ME));
        assertFalse("wisp's package", Shared.foreign("content", ME, ME));
        assertTrue("a name that only starts the same", Shared.foreign("content", ME + "x.files", ME));
    }

    @Test
    public void noTokenOrAWrongOneGetsNothing() {
        Shared.Token t = new Shared.Token();
        assertFalse(t.claim(null));
        assertFalse(t.claim(""));
        assertFalse(t.claim("0".repeat(t.toString().length())));
        assertFalse(t.claim(t.toString().substring(1)));
        assertFalse("nothing to fetch before the read", t.holds(t.toString()));
        assertTrue("a wrong try doesn't use it up", t.claim(t.toString()));
    }

    @Test
    public void aTokenReadsOnce() {
        Shared.Token t = new Shared.Token();
        assertTrue(t.claim(t.toString()));
        assertFalse("used twice", t.claim(t.toString()));
        assertTrue("its files, after the read", t.holds(t.toString()));
        assertFalse(t.holds(null));
        assertFalse(t.holds("wrong"));
    }

    @Test
    public void tokensAreLongAndNeverRepeat() {
        String a = new Shared.Token().toString();
        assertEquals(48, a.length());
        assertNotEquals(a, new Shared.Token().toString());
    }

    @Test
    public void onlyTheTypesTheFilterOffers() {
        assertTrue(Shared.allowedType("image/png"));
        assertTrue(Shared.allowedType("TEXT/PLAIN"));
        assertTrue(Shared.allowedType("application/pdf"));
        assertFalse(Shared.allowedType("application/zip"));
        assertFalse(Shared.allowedType("video/mp4"));
        assertFalse(Shared.allowedType(null));
    }
}
