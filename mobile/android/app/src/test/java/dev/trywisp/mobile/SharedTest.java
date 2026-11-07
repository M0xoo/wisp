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
    public void originsAreThePagesOwn() {
        assertEquals("http://127.0.0.1:4477", Shared.originOf("http://127.0.0.1:4477/?m=Studio#/s/a1"));
        assertEquals("https://mokh.grid.dev", Shared.originOf("HTTPS://Mokh.Grid.Dev:443/_grid/auth?t=x"));
        assertEquals("http://x.dev", Shared.originOf("http://x.dev:80"));
        assertEquals("https://x.dev:8443", Shared.originOf("https://x.dev:8443?a"));
        assertEquals(null, Shared.originOf(null));
        assertEquals(null, Shared.originOf("capacitor://localhost/index.html"));
        assertEquals("a name before an @ isn't the host", null, Shared.originOf("http://127.0.0.1:4477@evil.dev/"));
        assertEquals(null, Shared.originOf("http://evil.dev\\@127.0.0.1:4477/"));
    }

    @Test
    public void onlyThePageOfTheOpenComputerIsWisps() {
        String tunnel = "http://127.0.0.1:4477";
        assertTrue(Shared.isPage(tunnel + "/?m=Studio", tunnel));
        assertFalse("nothing open", Shared.isPage(tunnel + "/", null));
        assertFalse("an agent's server on this phone's loopback", Shared.isPage("http://127.0.0.1:5173/", tunnel));
        assertFalse("the app's own list", Shared.isPage("https://localhost/", tunnel));
        String cloud = "https://mokh.grid.dev";
        assertTrue(Shared.isPage(cloud + "/?m=x#/s/a1", cloud));
        assertTrue("a computer on the grid", Shared.isPage("https://studio--mokh.grid.dev/", "https://studio--mokh.grid.dev"));
        assertFalse("another person on the grid", Shared.isPage("https://eve.grid.dev/", cloud));
        assertFalse("the grid itself", Shared.isPage("https://grid.dev/", cloud));
        assertFalse("a preview of the same box", Shared.isPage("https://p5173--mokh.grid.dev/", cloud));
        assertFalse("a preview of a computer", Shared.isPage("https://p5173--studio--mokh.grid.dev/", "https://studio--mokh.grid.dev"));
        assertFalse("plain http", Shared.isPage("http://mokh.grid.dev/", cloud));
        assertFalse("under a domain of its own", Shared.isPage("https://mokh.grid.dev.evil.dev/", cloud));
    }

    @Test
    public void anAgentsHostIsNeverWispsEvenIfTheListOpenedIt() {
        for (String host : new String[] {"p5173--mokh", "p80--studio--mokh", "blog--app--mokh", "sb-0123abcd--mokh"}) {
            String origin = "https://" + host + ".grid.dev";
            assertFalse(host, Shared.isPage(origin + "/", origin));
        }
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
