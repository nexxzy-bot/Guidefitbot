package ru.guidefit.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.HttpsURLConnection;

/**
 * GuideFit — WebView-обёртка для RuStore.
 * Загружает приложение с https://app.xn--80aag3axnld9b.xn--p1ai,
 * внешние домены (VK ID) открывает в системном браузере.
 *
 * RuStore (требование «обновления»): при выходе новой версии пользователю
 * показывается уведомление с рекомендацией обновиться через RuStore.
 * Проверка — лёгкий GET /api/app-version, не чаще раза в 6 часов.
 *
 * v32: Telegram удалён из продукта. Напоминания стали ЛОКАЛЬНЫМИ — их планирует
 * этот APK (AlarmManager → ReminderReceiver), а веб-слой получает доступ к
 * планировщику через мост window.GuideFitNative.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "https://app.xn--80aag3axnld9b.xn--p1ai/";
    private static final String STORE_URL = "https://www.rustore.ru/catalog/app/ru.guidefit.app";
    private static final String VERSION_CHECK_URL = "https://app.xn--80aag3axnld9b.xn--p1ai/api/app-version";
    private static final long CHECK_INTERVAL_MS = 6L * 3600 * 1000; // раз в 6 часов

    // Домены, которые остаются внутри WebView (само приложение и вход по VK ID)
    private static final String[] INTERNAL_HOSTS = {
            "app.xn--80aag3axnld9b.xn--p1ai",
            "id.vk.ru", "oauth.vk.ru", "login.vk.ru", "api.vk.ru",
            "id.vk.com", "oauth.vk.com", "login.vk.com", "api.vk.com",
            "connect.ok.ru", "api.ok.ru"
    };

    private WebView webView;
    private FrameLayout rootLayout;
    private ImageView splashView;
    private LinearLayout errorView;
    private SharedPreferences prefs;
    private String versionName = "0.0.0";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences("gf_app", MODE_PRIVATE);
        try {
            versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            versionName = "0.0.0";
        }

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#F2F7FC"));
        if (Build.VERSION.SDK_INT >= 23) {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        webView = new WebView(this);

        // Нативный сплэш + экран «нет сети»: обёртка самодостаточна даже без сети
        rootLayout = new FrameLayout(this);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        splashView = new ImageView(this);
        splashView.setImageResource(R.drawable.splash);
        splashView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        splashView.setBackgroundColor(Color.parseColor("#F2F7FC"));
        rootLayout.addView(splashView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        rootLayout.addView(errorView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(rootLayout);

        ReminderScheduler.ensureChannel(this);
        // Мост для веб-слоя: локальные напоминания. Никаких данных наружу не уходит.
        webView.addJavascriptInterface(new NativeBridge(), "GuideFitNative");

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage: сессия, тема
        s.setDatabaseEnabled(true);
        s.setLoadsImagesAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // версия приложения из манифеста — не захардкожена
        s.setUserAgentString(s.getUserAgentString() + " GuideFit/" + versionName + " RuStore");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, false); // без сторонних cookie (152-ФЗ, без трекеров)
        if (Build.VERSION.SDK_INT >= 21) cm.flush();

        webView.setBackgroundColor(Color.parseColor("#F2F7FC"));
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isInternal(request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().flush();
                hideSplash();
                hideError();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // ошибка загрузки самой страницы (не картинки внутри) — показываем нативный экран
                if (Build.VERSION.SDK_INT >= 23 && request != null && request.isForMainFrame()) {
                    showError();
                }
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    private boolean isInternal(String url) {
        if (url == null) return false;
        for (String host : INTERNAL_HOSTS) {
            if (url.contains("://" + host) || url.contains(".//" + host)) return true;
        }
        // любые прочие vk/ok-домены тоже считаем внутренними (виджет VK ID может редиректить)
        return url.contains("://vk.ru") || url.contains("://vk.com") || url.contains("://ok.ru")
                || url.contains(".vk.ru/") || url.contains(".vk.com/") || url.contains(".ok.ru/");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    /* ===== мост в веб-слой: локальные уведомления =====
       Доступен только нашему же приложению (WebView грузит единственный доверенный домен,
       внешние ссылки уходят в системный браузер), поэтому наружу интерфейс не торчит. */
    public class NativeBridge {

        @JavascriptInterface
        public boolean notificationsAllowed() {
            return ReminderReceiver.notificationsAllowed(MainActivity.this);
        }

        /** Системный запрос разрешения на уведомления (Android 13+). */
        @JavascriptInterface
        public void requestNotifications() {
            if (Build.VERSION.SDK_INT < 33) return;
            if (ReminderReceiver.notificationsAllowed(MainActivity.this)) return;
            runOnUiThread(() -> {
                try { requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9001); }
                catch (Exception ignored) { }
            });
        }

        /** Расписание из приложения: {"enabled":true,"entries":[{id,hour,minute,title,text}]} */
        @JavascriptInterface
        public void setReminders(String json) {
            try {
                JSONArray entries = null;
                String t = json == null ? "" : json.trim();
                if (t.startsWith("[")) {
                    entries = new JSONArray(t);
                } else {
                    JSONObject obj = new JSONObject(t);
                    entries = obj.optJSONArray("entries");
                }
                if (entries == null || entries.length() == 0) { ReminderScheduler.cancelAll(MainActivity.this); return; }
                ReminderScheduler.schedule(MainActivity.this, entries);
                ReminderScheduler.setEnabled(MainActivity.this, true);
            } catch (Exception ignored) {
                // мусорный JSON просто игнорируем — будильники не трогаем
            }
        }

        @JavascriptInterface
        public void clearReminders() {
            ReminderScheduler.cancelAll(MainActivity.this);
        }

        @JavascriptInterface
        public String appVersion() {
            return versionName;
        }
    }

    /* ===== сплэш и экран «нет сети» ===== */

    private void hideSplash() {
        if (splashView != null && splashView.getVisibility() == View.VISIBLE) {
            splashView.animate().alpha(0f).setDuration(250).withEndAction(() -> {
                if (splashView != null) splashView.setVisibility(View.GONE);
            }).start();
        }
    }

    private void showError() {
        if (errorView != null) errorView.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        if (errorView != null) errorView.setVisibility(View.GONE);
    }

    /** Нативный экран ошибки: заголовок, подпись и кнопка «Повторить» (перезагрузка URL). */
    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#F2F7FC"));
        box.setPadding(dp(32), dp(32), dp(32), dp(32));

        TextView title = new TextView(this);
        title.setText("Нет подключения");
        title.setTextSize(20);
        title.setTextColor(Color.parseColor("#0C2233"));
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Проверь интернет и попробуй ещё раз. Данные сохранены на устройстве.");
        sub.setTextSize(14);
        sub.setTextColor(Color.parseColor("#5B7183"));
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(10), 0, dp(24));
        box.addView(sub);

        Button retry = new Button(this);
        retry.setText("Повторить");
        retry.setTextColor(Color.WHITE);
        retry.getBackground().setColorFilter(Color.parseColor("#0E7490"), android.graphics.PorterDuff.Mode.SRC_ATOP);
        retry.setOnClickListener(v -> {
            hideError();
            webView.loadUrl(APP_URL);
        });
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rp.gravity = Gravity.CENTER_HORIZONTAL;
        box.addView(retry, rp);
        return box;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        // back внутри приложения: сначала история WebView, потом выход
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
        if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        maybeCheckUpdate();
    }

    /* ===== RuStore: уведомление о новой версии ===== */

    private void maybeCheckUpdate() {
        long last = prefs.getLong("last_update_check", 0L);
        long now = System.currentTimeMillis();
        if (now - last < CHECK_INTERVAL_MS) return;
        prefs.edit().putLong("last_update_check", now).apply();

        final String self = versionName;
        new Thread(() -> {
            try {
                URL u = new URL(VERSION_CHECK_URL + "?platform=android&v=" + self);
                HttpsURLConnection c = (HttpsURLConnection) u.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("Accept", "application/json");
                int code = c.getResponseCode();
                if (code != 200) return;
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
                r.close();
                c.disconnect();

                JSONObject j = new JSONObject(sb.toString());
                String latest = j.optString("latest", "");
                String min = j.optString("min", latest);
                boolean force = j.optBoolean("force", false);
                String message = j.optString("message", "");
                if (latest.isEmpty()) return;

                boolean outdated = cmpVersion(self, latest) < 0;
                boolean belowMin = cmpVersion(self, min) < 0;
                if (outdated || belowMin) {
                    final boolean blocking = force || belowMin;
                    final String msg = message;
                    runOnUiThread(() -> showUpdateDialog(blocking, msg));
                }
            } catch (Exception e) {
                // тихо: проверка не должна влиять на работу приложения
            }
        }, "gf-update-check").start();
    }

    private void showUpdateDialog(boolean blocking, String message) {
        if (isFinishing() || isDestroyed()) return;
        String text = (message != null && !message.trim().isEmpty())
                ? message
                : "Вышла новая версия GuideFit. Обновите приложение в RuStore, чтобы получить свежие исправления и возможности.";
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("Доступно обновление")
                .setMessage(text)
                .setPositiveButton("Обновить в RuStore", (d, which) -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(STORE_URL)));
                    } catch (Exception ignored) { }
                })
                .setCancelable(!blocking);
        if (!blocking) b.setNegativeButton("Позже", null);
        b.show();
    }

    /** Сравнение версий вида "2.3.1": -1 если a<b, 0 если равны, 1 если a>b */
    private static int cmpVersion(String a, String b) {
        try {
            String[] pa = a.split("\\.");
            String[] pb = b.split("\\.");
            int n = Math.max(pa.length, pb.length);
            for (int i = 0; i < n; i++) {
                int xa = i < pa.length ? Integer.parseInt(pa[i].replaceAll("[^0-9]", "")) : 0;
                int xb = i < pb.length ? Integer.parseInt(pb[i].replaceAll("[^0-9]", "")) : 0;
                if (xa != xb) return xa < xb ? -1 : 1;
            }
            return 0;
        } catch (Exception e) {
            return 0;
        }
    }
}
