package dev.trywisp.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.security.Security;
import java.util.List;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.BeforeClass;
import org.junit.Test;

public class KeysTest {
    @BeforeClass
    public static void bc() {
        Security.removeProvider("BC");
        Security.insertProviderAt(new BouncyCastleProvider(), 1);
    }

    private static Keys fresh() throws Exception {
        return new Keys(Files.createTempDirectory("wisp-keys").toFile());
    }

    @Test
    public void makesTheFirstKeyAndKeepsIt() throws Exception {
        Keys k = fresh();
        List<Keys.Info> first = k.listOrCreate();
        assertEquals(1, first.size());
        assertEquals("This phone", first.get(0).name);
        String line = Keys.authorizedKey(first.get(0).pub);
        assertTrue(line, line.matches("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ wisp-phone"));
        assertTrue(Keys.fingerprint(first.get(0).pub).matches("SHA256:[A-Za-z0-9+/]{43}"));
        // Same key next time, and it loads as a usable pair.
        assertEquals(Keys.fingerprint(first.get(0).pub), Keys.fingerprint(k.listOrCreate().get(0).pub));
        assertEquals(Keys.fingerprint(first.get(0).pub), Keys.fingerprint(k.load(first.get(0).id).getPublic()));
    }

    @Test
    public void createsDeletesAndRefusesOddIds() throws Exception {
        Keys k = fresh();
        Keys.Info a = k.create("Work");
        Keys.Info b = k.create("Home");
        assertEquals(2, k.list().size());
        k.delete(a.id);
        assertEquals(b.id, k.list().get(0).id);
        try {
            k.load("../../etc/passwd");
            fail("loaded a path");
        } catch (IllegalArgumentException expected) {
            // ids never leave the keys folder
        }
    }

    // One damaged key (a truncated file, an unknown algorithm) is skipped and named; the rest list.
    @Test
    public void skipsAKeyThatDoesNotLoad() throws Exception {
        File dir = Files.createTempDirectory("wisp-keys").toFile();
        Keys k = new Keys(dir);
        Keys.Info good = k.create("Good");
        Keys.Info cut = k.create("Cut");
        Keys.Info odd = k.create("Odd");
        Files.write(new File(dir, cut.id + ".pub").toPath(), new byte[] { 1, 2, 3 });
        File props = new File(dir, odd.id + ".properties");
        Files.write(props.toPath(), new String(Files.readAllBytes(props.toPath())).replace("alg=Ed25519", "alg=Nope").getBytes());
        List<String> unreadable = new ArrayList<>();
        List<Keys.Info> l = k.list(unreadable);
        assertEquals(1, l.size());
        assertEquals(good.id, l.get(0).id);
        assertEquals(List.of("Cut", "Odd"), unreadable.stream().sorted().toList());
        // Nothing usable left: a fresh key is made; the damaged files stay on disk.
        k.delete(good.id);
        List<Keys.Info> fresh = k.listOrCreate();
        assertEquals(1, fresh.size());
        assertEquals("This phone", fresh.get(0).name);
        assertTrue(new File(dir, cut.id + ".key").exists());
    }

    // ssh-keygen output, plain and with a passphrase: the same fingerprint ssh-keygen -lf prints.
    @Test
    public void importsOpenSshKeys() throws Exception {
        File dir = Files.createTempDirectory("wisp-kg").toFile();
        for (String[] t : new String[][] { { "ed25519", "" }, { "rsa", "" }, { "ecdsa", "" }, { "ed25519", "s3cret" } }) {
            File f = new File(dir, "k-" + t[0] + t[1].length());
            Process p = new ProcessBuilder("ssh-keygen", "-q", "-t", t[0], "-N", t[1], "-f", f.getPath()).redirectErrorStream(true).start();
            assertEquals(0, p.waitFor());
            Process fp = new ProcessBuilder("ssh-keygen", "-lf", f.getPath() + ".pub").start();
            String expected = new String(fp.getInputStream().readAllBytes()).split(" ")[1];
            Keys k = fresh();
            String pem = new String(Files.readAllBytes(f.toPath()));
            if (!t[1].isEmpty()) {
                try {
                    k.importKey("x", pem, null);
                    fail("imported without the passphrase");
                } catch (Exception e) {
                    assertTrue(e.getMessage(), e.getMessage().contains("passphrase"));
                }
            }
            Keys.Info info = k.importKey("Laptop", pem, t[1]);
            assertEquals(t[0], expected, Keys.fingerprint(info.pub));
            assertEquals("imported", info.source);
            assertEquals(expected, Keys.fingerprint(k.load(info.id).getPublic()));
        }
    }

    @Test
    public void refusesThingsThatAreNotKeys() throws Exception {
        try {
            fresh().importKey("x", "hello", null);
            fail("imported garbage");
        } catch (Exception e) {
            assertTrue(e.getMessage(), e.getMessage().contains("private key"));
        }
    }
}
