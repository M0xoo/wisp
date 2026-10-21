package dev.trywisp.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import net.schmizz.sshj.DefaultConfig;
import net.schmizz.sshj.common.Buffer;
import net.schmizz.sshj.common.Factory;
import net.schmizz.sshj.common.KeyType;
import net.schmizz.sshj.userauth.keyprovider.FileKeyProvider;
import net.schmizz.sshj.userauth.keyprovider.KeyFormat;
import net.schmizz.sshj.userauth.keyprovider.KeyProviderUtil;
import net.schmizz.sshj.userauth.password.PasswordUtils;

/**
 * The phone's SSH keys, kept in the app's private files (backups are off in the manifest). Each
 * key is `<id>.key` (PKCS#8), `<id>.pub` (X.509) and `<id>.properties` (name, algorithm, made here
 * or imported). Imported keys are decrypted once on import, so their passphrase isn't kept.
 * Plain Java, so the desktop check runs it too.
 */
public final class Keys {
    public static final class Info {
        public final String id, name, source;
        public final PublicKey pub;

        Info(String id, String name, String source, PublicKey pub) {
            this.id = id;
            this.name = name;
            this.source = source;
            this.pub = pub;
        }
    }

    private final File dir;

    public Keys(File dir) {
        this.dir = dir;
        dir.mkdirs();
    }

    public synchronized List<Info> list() throws GeneralSecurityException, IOException {
        List<Info> out = new ArrayList<>();
        File[] files = dir.listFiles((d, n) -> n.endsWith(".properties"));
        if (files != null) {
            java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File f : files) {
                String id = f.getName().replace(".properties", "");
                Properties p = props(id);
                out.add(new Info(id, p.getProperty("name", "Key"), p.getProperty("source", "phone"), load(id).getPublic()));
            }
        }
        return out;
    }

    /** The phone's first key, made the first time the app needs one. */
    public synchronized List<Info> listOrCreate() throws GeneralSecurityException, IOException {
        List<Info> l = list();
        if (l.isEmpty()) {
            create("This phone");
            l = list();
        }
        return l;
    }

    public synchronized Info create(String name) throws GeneralSecurityException, IOException {
        KeyPair kp = KeyPairGenerator.getInstance("Ed25519", "BC").generateKeyPair();
        return save(name, "phone", kp);
    }

    /** An existing private key (OpenSSH, PEM or PuTTY), as pasted. */
    public synchronized Info importKey(String name, String privateKey, String passphrase) throws IOException, GeneralSecurityException {
        KeyFormat format = KeyProviderUtil.detectKeyFileFormat(privateKey, false);
        FileKeyProvider fkp = Factory.Named.Util.create(new DefaultConfig().getFileKeyProviderFactories(), format.toString());
        if (fkp == null) throw new IOException("That doesn’t look like a private key (OpenSSH, PEM or PuTTY).");
        fkp.init(privateKey, null, passphrase == null || passphrase.isEmpty() ? null : PasswordUtils.createOneOff(passphrase.toCharArray()));
        KeyPair kp;
        try {
            kp = new KeyPair(fkp.getPublic(), fkp.getPrivate());
        } catch (IOException e) {
            throw new IOException(passphrase == null || passphrase.isEmpty() ? "That key needs its passphrase." : "Wrong passphrase, or the key is damaged.");
        }
        return save(name, "imported", kp);
    }

    public synchronized void delete(String id) {
        for (String ext : new String[] { ".key", ".pub", ".properties" }) new File(dir, safe(id) + ext).delete();
    }

    public synchronized KeyPair load(String id) throws GeneralSecurityException, IOException {
        String alg = props(id).getProperty("alg", "Ed25519");
        KeyFactory kf = KeyFactory.getInstance(alg, "BC");
        return new KeyPair(
            kf.generatePublic(new X509EncodedKeySpec(Files.readAllBytes(new File(dir, safe(id) + ".pub").toPath()))),
            kf.generatePrivate(new PKCS8EncodedKeySpec(Files.readAllBytes(new File(dir, safe(id) + ".key").toPath())))
        );
    }

    private Info save(String name, String source, KeyPair kp) throws IOException {
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        Files.write(new File(dir, id + ".key").toPath(), kp.getPrivate().getEncoded());
        Files.write(new File(dir, id + ".pub").toPath(), kp.getPublic().getEncoded());
        Properties p = new Properties();
        p.setProperty("name", name == null || name.trim().isEmpty() ? "Key" : name.trim());
        p.setProperty("alg", kp.getPublic().getAlgorithm());
        p.setProperty("source", source);
        try (OutputStream o = new FileOutputStream(new File(dir, id + ".properties"))) {
            p.store(o, null);
        }
        return new Info(id, p.getProperty("name"), source, kp.getPublic());
    }

    private Properties props(String id) throws IOException {
        Properties p = new Properties();
        try (InputStream in = new FileInputStream(new File(dir, safe(id) + ".properties"))) {
            p.load(in);
        }
        return p;
    }

    // Ids come from the page: never let one reach outside the keys folder.
    private static String safe(String id) {
        if (id == null || !id.matches("[a-z0-9]{1,32}")) throw new IllegalArgumentException("No such key.");
        return id;
    }

    /** The authorized_keys line: `ssh-ed25519 AAAA… wisp-phone`. */
    public static String authorizedKey(PublicKey key) {
        return KeyType.fromKey(key) + " " + Base64.getEncoder().encodeToString(blob(key)) + " wisp-phone";
    }

    /** `SHA256:…`, the way `ssh-keygen -lf` prints it, so it can be checked on the machine. */
    public static String fingerprint(PublicKey key) {
        try {
            byte[] sha = MessageDigest.getInstance("SHA-256").digest(blob(key));
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(sha);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] blob(PublicKey key) {
        return new Buffer.PlainBuffer().putPublicKey(key).getCompactData();
    }
}
