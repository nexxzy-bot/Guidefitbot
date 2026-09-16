package ru.guidefit.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * GuideFit — WebView-обёртка для RuStore.
 * Загружает приложение с https://app.xn--80aag3axnld9b.xn--p1ai,
 * внешние домены (VK ID, Telegram OAuth) открывает в системном браузере.
 */
public class MainActivity extends Activity {

    private static final String APP_URL = "https://app.xn--80aag3axnld9b.xn--p1ai/";
    // Домены, которые остаются внутри WebView (само приложение и вход по VK ID)
    private static final String[] INTERNAL_HOSTS = {
            "app.xn--80aag3axnld9b.xn--p1ai",
            "id.vk.ru", "oauth.vk.ru", "login.vk.ru", "api.vk.ru",
            "id.vk.com", "oauth.vk.com", "login.vk.com", "api.vk.com",
            "connect.ok.ru", "api.ok.ru"
    };

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#F2F7FC"));
        if (Build.VERSION.SDK_INT >= 23) {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        webView = new WebView(this);
        setContentView(webView);

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
        s.setUserAgentString(s.getUserAgentString() + " GuideFit/2.2.0 RuStore");

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
    }
}
