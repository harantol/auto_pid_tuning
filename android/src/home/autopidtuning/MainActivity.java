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
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Betaflight auto-tune: the web app (app/ in the repository), shown in a WebView.
 *
 * The page and its analysis code ship inside the app, as assets under app/, and the analysis
 * runs on the phone: no server and no network are needed. The assets are served on a
 * reserved https host, so the page gets a real origin (JavaScript modules and workers refuse
 * file:// pages). The page asks the phone for what it cannot do in a WebView: copy to the
 * clipboard and save a file.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1;
    // Reserved for apps serving their own content (as AndroidX WebViewAssetLoader does).
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);

        web.addJavascriptInterface(new Bridge(), "AutoPidAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!HOST.equals(url.getHost())) return null;
                return asset(url.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url)); // other sites: in the browser
                } catch (ActivityNotFoundException e) {
                    // no browser: ignore the link
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return chooseFile(callback);
            }
        });

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(HOME);
    }

    /** A file of the page, from the assets; 404 when there is none. */
    private WebResourceResponse asset(String path) {
        if (path == null || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();
        try {
            return new WebResourceResponse(mimeType(path), "utf-8", getAssets().open("app" + path));
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse response = new WebResourceResponse("text/plain", "utf-8", null);
        response.setStatusCodeAndReasonPhrase(404, "Not Found");
        return response;
    }

    /** JavaScript modules are only run when served with a JavaScript type. */
    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".json")) return "application/json";
        return "application/octet-stream";
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
