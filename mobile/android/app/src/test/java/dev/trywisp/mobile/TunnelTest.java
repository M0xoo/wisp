package dev.trywisp.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.Security;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.BeforeClass;
import org.junit.Test;

/**
 * Against a real sshd and wisp, so only when asked (see mobile/README.md):
 *   WISP_SSH_TEST=user@host:sshPort  WISP_SSH_KEY=<private key file>
 *   WISP_SSH_SCRIPT=<bootstrapScript output>  WISP_SSH_PORT=<wisp port there>
 * The phone end listens on [::1] so a wisp on this same computer can keep 127.0.0.1:port.
 */
public class TunnelTest {
    @BeforeClass
    public static void bc() {
        Security.removeProvider("BC");
        Security.insertProviderAt(new BouncyCastleProvider(), 1);
    }

    private static Tunnel tunnel(String keyFile, List<String> lines, Tunnel.HostKeys hk) throws Exception {
        String t = System.getenv("WISP_SSH_TEST");
        String user = t.substring(0, t.indexOf('@'));
        String host = t.substring(t.indexOf('@') + 1, t.lastIndexOf(':'));
        int sshPort = Integer.parseInt(t.substring(t.lastIndexOf(':') + 1));
        Keys keys = new Keys(Files.createTempDirectory("wisp-keys").toFile());
        Keys.Info k = keyFile != null ? keys.importKey("test", new String(Files.readAllBytes(Paths.get(keyFile))), null) : keys.create("stranger");
        String script = new String(Files.readAllBytes(Paths.get(System.getenv("WISP_SSH_SCRIPT"))));
        Tunnel tn = new Tunnel(host, sshPort, user, null, Integer.parseInt(System.getenv("WISP_SSH_PORT")), script, keys.load(k.id), hk, lines::add);
        tn.bindHost = "::1";
        return tn;
    }

    private static void waitFor(List<String> lines, String prefix) throws InterruptedException {
        for (int i = 0; i < 300 && lines.stream().noneMatch(l -> l.startsWith(prefix) || l.startsWith("@@wisp fail")); i++) Thread.sleep(100);
    }

    @Test
    public void bootstrapsAndForwards() throws Exception {
        assumeTrue(System.getenv("WISP_SSH_TEST") != null);
        List<String> lines = new CopyOnWriteArrayList<>();
        Tunnel tn = tunnel(System.getenv("WISP_SSH_KEY"), lines, (h, p, fp) -> true);
        tn.start();
        waitFor(lines, "@@wisp open");
        System.out.println(String.join("\n", lines));
        assertEquals("ready", tn.state());
        assertTrue(lines.stream().anyMatch(l -> l.startsWith("@@wisp step node done")));
        assertTrue(lines.stream().anyMatch(l -> l.startsWith("@@wisp step wisp done")));
        assertTrue(lines.stream().anyMatch(l -> l.startsWith("@@wisp step tunnel done")));
        // wisp's page answers through the tunnel, with the Host it insists on.
        java.net.HttpURLConnection h = (java.net.HttpURLConnection) new java.net.URL("http://[::1]:" + tn.port + "/").openConnection();
        assertEquals(200, h.getResponseCode());
        assertTrue(new String(h.getInputStream().readAllBytes()).contains("wisp"));

        // A dropped connection comes back on its own.
        tn.close();
        for (int i = 0; i < 100 && lines.stream().filter(l -> l.startsWith("@@wisp open")).count() < 2; i++) Thread.sleep(100);
        assertTrue(String.join("\n", lines), lines.stream().anyMatch(l -> l.startsWith("@@wisp lost")));
        assertTrue(lines.contains("@@wisp step ssh run Reconnecting…"));
        assertEquals(2, lines.stream().filter(l -> l.startsWith("@@wisp open")).count());
        assertEquals("ready", tn.state());
        tn.stop();
        assertEquals("idle", tn.state());
    }

    @Test
    public void unknownKeyAndChangedHostKeyFail() throws Exception {
        assumeTrue(System.getenv("WISP_SSH_TEST") != null);
        List<String> lines = new CopyOnWriteArrayList<>();
        Tunnel tn = tunnel(null, lines, (h, p, fp) -> true);
        tn.start();
        waitFor(lines, "@@wisp fail");
        assertEquals("failed", tn.state());
        assertTrue(String.join("\n", lines), lines.stream().anyMatch(l -> l.startsWith("@@wisp fail ssh Authentication failed")));

        List<String> lines2 = new CopyOnWriteArrayList<>();
        Tunnel tn2 = tunnel(System.getenv("WISP_SSH_KEY"), lines2, (h, p, fp) -> false);
        tn2.start();
        waitFor(lines2, "@@wisp fail");
        assertTrue(String.join("\n", lines2), lines2.stream().anyMatch(l -> l.startsWith("@@wisp fail ssh The host key changed: it is now SHA256:")));
    }
}
