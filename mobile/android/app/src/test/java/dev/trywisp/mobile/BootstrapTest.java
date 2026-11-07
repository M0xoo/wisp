package dev.trywisp.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/** v2's bootstrap fields, server.json's token and peer, and where a saved computer is. */
public class BootstrapTest {
    private static final String TEMPLATE = "PORT=__PORT__\nINSTALL=__INSTALL__\nAPI=__API__\nCMD=__CMD__\n";

    @Test
    public void fillsTheFieldsAndQuotesTheCommand() throws Exception {
        String sh = Bootstrap.fill(TEMPLATE, 4555, " wisp-agents@1.2.3 # it's ");
        assertEquals("PORT=4555\nINSTALL=1\nAPI=any\nCMD='wisp-agents@1.2.3 # it'\\''s'\n", sh);
        assertEquals("PORT=4477\nINSTALL=1\nAPI=any\nCMD=''\n", Bootstrap.fill(TEMPLATE, 4477, ""));
        // a real sh reads the quoted command back unchanged
        File f = File.createTempFile("boot", ".sh");
        Files.write(f.toPath(), (sh + "printf '%s' \"$CMD\"").getBytes(StandardCharsets.UTF_8));
        Process p = new ProcessBuilder("sh", f.getPath()).start();
        assertEquals("wisp-agents@1.2.3 # it's", new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
        f.delete();
    }

    @Test
    public void readsTokenAndPeerFromServerJson() {
        String json = "{\n  \"url\": \"http://127.0.0.1:4477\",\n  \"port\": 4477,\n  \"peer\": \"studio-1f3a\",\n  \"token\" : \"wlt_abc123\"\n}";
        assertEquals("wlt_abc123", Bootstrap.field(json, "token"));
        assertEquals("studio-1f3a", Bootstrap.field(json, "peer"));
        assertEquals("", Bootstrap.field("{\"url\":\"http://127.0.0.1:4477\"}", "token")); // a wisp without one
        assertEquals("", Bootstrap.field(null, "token"));
        assertEquals("", Bootstrap.field("", "peer"));
    }

    @Test
    public void parsesWhereASavedComputerIs() {
        Bootstrap.Target t = Bootstrap.target(" me@studio.local:2222 ", 22);
        assertEquals("me", t.user);
        assertEquals("studio.local", t.host);
        assertEquals(2222, t.sshPort);
        t = Bootstrap.target("a@b@box", 2200); // the last @ splits: a user name may hold one
        assertEquals("a@b", t.user);
        assertEquals("box", t.host);
        assertEquals(2200, t.sshPort);
        t = Bootstrap.target("box", 22);
        assertEquals("", t.user);
        assertEquals("box", t.host);
        assertTrue(Bootstrap.target(null, 22).host.isEmpty());
    }

    @Test
    public void aFailureLineGivesItsMessage() {
        assertEquals("Connection refused by box:22.", Reach.failure("@@wisp fail ssh Connection refused by box:22."));
        assertEquals("install", Reach.failure("@@wisp fail install"));
    }
}
