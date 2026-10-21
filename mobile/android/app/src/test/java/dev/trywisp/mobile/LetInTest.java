package dev.trywisp.mobile;

import static org.junit.Assert.assertEquals;

import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/** The command that adds the phone's key there, run by a real sh in a throwaway home. */
public class LetInTest {
    private static void run(File home, String key) throws Exception {
        // sshd hands the command to the login shell: sh -c "<ADD_KEY>".
        ProcessBuilder pb = new ProcessBuilder("sh", "-c", Tunnel.ADD_KEY);
        pb.environment().put("HOME", home.getPath());
        Process p = pb.start();
        try (OutputStream in = p.getOutputStream()) {
            in.write((key + "\n").getBytes(StandardCharsets.UTF_8));
        }
        assertEquals(0, p.waitFor());
    }

    @Test
    public void addsTheKeyOnceWithPrivatePermissions() throws Exception {
        File home = Files.createTempDirectory("wisp-there").toFile();
        String key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample wisp-phone";
        run(home, key);
        run(home, key); // again: not added twice
        File ak = new File(home, ".ssh/authorized_keys");
        assertEquals(key + "\n", new String(Files.readAllBytes(ak.toPath()), StandardCharsets.UTF_8));
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(ak.toPath())));
        // A key already there from someone else stays.
        Files.write(ak.toPath(), ("ssh-rsa AAAA laptop\n" + key + "\n").getBytes(StandardCharsets.UTF_8));
        run(home, key);
        assertEquals("ssh-rsa AAAA laptop\n" + key + "\n", new String(Files.readAllBytes(ak.toPath()), StandardCharsets.UTF_8));
    }
}
