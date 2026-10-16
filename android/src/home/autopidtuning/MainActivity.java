package home.autopidtuning;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.Html;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Betaflight auto-tune: the web app served by S13, shown in a WebView.
 *
 * The analysis runs on S13, so the app only works where S13 is reachable (the home WiFi).
 * When it is not, a short page says so and offers to retry. The page asks the phone for the
 * two things a plain HTTP page cannot do in a WebView: copy to the clipboard and save a file.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;

    private WebView web;
    private String server;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        server = readAsset("server.txt").trim();

        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);

        web.addJavascriptInterface(new Bridge(), "AutoPidAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url.getHost() != null && url.getHost().equals(Uri.parse(server).getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url)); // other sites: in the browser
                } catch (ActivityNotFoundException e) {
                    // no browser: ignore the link
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showUnreachable(String.valueOf(error.getDescription()));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return chooseFile(callback);
            }
        });

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(server);
    }

    /** S13 did not answer: say why it matters and offer to retry. */
    private void showUnreachable(String reason) {
        String page = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 20px;color:#0b0b0b;background:#fafaf7}"
                + "button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#2a78d6;color:#fff}"
                + "small{color:#898781}@media (prefers-color-scheme:dark){body{background:#111;color:#fff}}</style>"
                + "<h2>S13 is out of reach</h2>"
                + "<p>The analysis runs on the home server. Connect to the home WiFi, then retry.</p>"
                + "<p><button onclick=\"location.replace('" + Html.escapeHtml(server) + "')\">Retry</button></p>"
                + "<p><small>" + Html.escapeHtml(server) + " · " + Html.escapeHtml(reason) + "</small></p>";
        web.loadDataWithBaseURL(server, page, "text/html", "utf-8", server);
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[256];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString("UTF-8");
        } catch (IOException e) {
            return "";
        }
    }

    /** A blackbox log has no MIME type Android knows: offer every file. */
    private boolean chooseFile(ValueCallback<Uri[]> callback) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        try {
            startActivityForResult(Intent.createChooser(pick, "Blackbox log"), PICK_FILE);
            return true;
        } catch (ActivityNotFoundException e) {
            fileCallback = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE || fileCallback == null) return;
        Uri result = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(result == null ? null : new Uri[] { result });
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /** What the page can ask of the phone (window.AutoPidAndroid). */
    private class Bridge {
        @JavascriptInterface
        public void copy(String text) {
            getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Betaflight CLI", text));
        }

        /** Saves a text file in Downloads. */
        @JavascriptInterface
        public boolean save(String name, String text) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                return true;
            } catch (IOException | RuntimeException e) {
                return false;
            }
        }
    }
}
