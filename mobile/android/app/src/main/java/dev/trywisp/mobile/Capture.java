package dev.trywisp.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The camera for wisp's attach menu (web/js/features/attachments.js): an <input type=file
 * capture> with image/* takes a photo, with video/* records a video, and the file goes back to
 * the page like a picked one. Capacitor's own client does this too, but it finds the camera with
 * resolveActivity (null on Android 11+ without a <queries> entry, so it fell back to the file
 * picker) and its video path crashes when the camera app returns no intent. Everything else
 * (plain file picks, fullscreen video, console) stays Capacitor's.
 */
final class Capture extends BridgeWebChromeClient {
    private static final long KEEP_MS = 24 * 60 * 60 * 1000L; // a capture may still be uploading
    private static final long VIDEO_MAX = 450L * 1024 * 1024; // under the 500 MB uploads take (server/services/uploads.js)

    private final Context context;
    private final ActivityResultLauncher<Intent> launcher;
    private ValueCallback<Uri[]> pending;
    private File output;

    Capture(Bridge bridge) {
        super(bridge);
        context = bridge.getContext();
        launcher = bridge.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (r) -> {
            ValueCallback<Uri[]> cb = pending;
            File out = output;
            pending = null;
            output = null;
            if (cb == null) return;
            Uri got = null;
            if (r.getResultCode() == Activity.RESULT_OK) {
                if (out != null && out.length() > 0) got = uriOf(out);
                // Some camera apps ignore EXTRA_OUTPUT for video and hand back their own file.
                else if (r.getData() != null) got = r.getData().getData();
            }
            if (got == null && out != null) out.delete();
            cb.onReceiveValue(got == null ? null : new Uri[] { got });
        });
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        List<String> accept = Arrays.asList(params.getAcceptTypes());
        boolean video = accept.contains("video/*");
        if (!params.isCaptureEnabled() || !(video || accept.contains("image/*"))) return super.onShowFileChooser(view, callback, params);
        if (pending != null) pending.onReceiveValue(null); // a capture that never came back
        if (output != null) output.delete();
        pending = null;
        output = null;
        try {
            File dir = new File(context.getCacheDir(), "captures");
            sweep(dir);
            dir.mkdirs();
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(new Date());
            File out = new File(dir, video ? "video-" + stamp + ".mp4" : "photo-" + stamp + ".jpg");
            Intent intent = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uriOf(out));
            if (video) intent.putExtra(MediaStore.EXTRA_SIZE_LIMIT, VIDEO_MAX);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            pending = callback;
            output = out;
            launcher.launch(intent);
            return true;
        } catch (ActivityNotFoundException | IllegalArgumentException | SecurityException e) {
            // No camera app, no room for the file, or CAMERA declared (by a plugin) but not granted:
            // the picker still lets them choose one.
            pending = null;
            output = null;
            return super.onShowFileChooser(view, callback, params);
        }
    }

    private Uri uriOf(File f) {
        return FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", f);
    }

    // Captures older than a day: uploaded long ago (or never sent), only taking room.
    private static void sweep(File dir) {
        File[] old = dir.listFiles();
        if (old == null) return;
        long cut = System.currentTimeMillis() - KEEP_MS;
        for (File f : old) if (f.lastModified() < cut) f.delete();
    }
}
