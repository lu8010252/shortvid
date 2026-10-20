#!/usr/bin/env python3
"""cap add android 之后运行:放行 http、黑色状态栏/导航栏、换图标、写版本号、
接管返回键(交给网页处理)、全屏接口;TV 版另外加遥控器/横屏配置和「手机扫码填地址」小服务。
用法: patch_android.py <versionName> <versionCode> <icon.png> [phone|tv]
"""
import json
import os
import re
import sys

from PIL import Image, ImageDraw

version_name, version_code, icon_path = sys.argv[1], sys.argv[2], sys.argv[3]
variant = sys.argv[4] if len(sys.argv) > 4 else 'phone'
IS_TV = variant == 'tv'
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'android', 'app')
root = os.path.normpath(root)
res = os.path.join(root, 'src', 'main', 'res')


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


# 1. 清单:允许明文 http(家里/内网服务器常用);按版本加权限、遥控器入口
mf = os.path.join(root, 'src', 'main', 'AndroidManifest.xml')
s = read(mf)
if 'usesCleartextTraffic' not in s:
    extra_perm = ''
    app_attr = '\n        android:usesCleartextTraffic="true"'
    if IS_TV:
        extra_perm = ('<uses-feature android:name="android.software.leanback" android:required="false" />\n    '
                      '<uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n    ')
        app_attr += '\n        android:banner="@mipmap/ic_launcher"'
    else:
        extra_perm = ('<uses-permission android:name="android.permission.CAMERA" />\n    '
                      '<uses-feature android:name="android.hardware.camera" android:required="false" />\n    ')
    s = s.replace('<application', extra_perm + '<application' + app_attr, 1)
if IS_TV:
    if 'LEANBACK_LAUNCHER' not in s:
        s = re.sub(r'(<category android:name="android\.intent\.category\.LAUNCHER"\s*/>)',
                   r'\1\n                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />', s, count=1)
    if 'screenOrientation' not in s:
        s = s.replace('<activity', '<activity\n            android:screenOrientation="sensorLandscape"', 1)
write(mf, s)

# 2. 状态栏 / 导航栏纯黑,和页面底色一致
colors = os.path.join(res, 'values', 'colors.xml')
if os.path.exists(colors):
    s = read(colors)
    s = re.sub(r'(<color name="colorPrimary(?:Dark)?">)[^<]*(</color>)', r'\g<1>#000000\g<2>', s)
    write(colors, s)
styles = os.path.join(res, 'values', 'styles.xml')
s = read(styles)
extra = ('\n        <item name="android:statusBarColor">#000000</item>'
         '\n        <item name="android:navigationBarColor">#000000</item>'
         '\n        <item name="android:windowBackground">#000000</item>')
s = re.sub(r'(<style name="AppTheme\.NoActionBar"[^>]*>)', lambda m: m.group(1) + extra, s, count=1)
write(styles, s)

# 3. 图标:所有密度直接用 PNG(删除自适应图标 xml,避免旧图标残留)
sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
src = Image.open(icon_path).convert('RGBA')
for d, px in sizes.items():
    folder = os.path.join(res, 'mipmap-' + d)
    os.makedirs(folder, exist_ok=True)
    im = src.resize((px, px), Image.LANCZOS)
    im.save(os.path.join(folder, 'ic_launcher.png'))
    im.save(os.path.join(folder, 'ic_launcher_foreground.png'))
    mask = Image.new('L', (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mask = mask.resize((px, px), Image.LANCZOS)
    rnd = im.copy()
    rnd.putalpha(mask)
    rnd.save(os.path.join(folder, 'ic_launcher_round.png'))
any26 = os.path.join(res, 'mipmap-anydpi-v26')
if os.path.isdir(any26):
    for n in os.listdir(any26):
        os.remove(os.path.join(any26, n))
    os.rmdir(any26)

# 3.5 启动图:黑底 + 居中图标(替换 Capacitor 默认的 logo 启动图)
for dp, _, names in os.walk(res):
    for n in names:
        if n == 'splash.png':
            p = os.path.join(dp, n)
            w, h = Image.open(p).size
            bg = Image.new('RGB', (w, h), (0, 0, 0))
            side = max(64, min(w, h) // 4)
            logo = src.resize((side, side), Image.LANCZOS)
            bg.paste(logo, ((w - side) // 2, (h - side) // 2), logo)
            bg.save(p)

# 4. 版本号
gradle = os.path.join(root, 'build.gradle')
s = read(gradle)
s = re.sub(r'versionCode\s+\d+', 'versionCode ' + version_code, s, count=1)
s = re.sub(r'versionName\s+"[^"]*"', 'versionName "' + version_name + '"', s, count=1)
if IS_TV:
    # TV 版内置原生播放器(ExoPlayer):部分国产投影的系统 WebView 播不了视频
    dep = ('\n    implementation "androidx.media3:media3-exoplayer:1.3.1"'
           '\n    implementation "androidx.media3:media3-datasource:1.3.1"\n')
    if 'media3-exoplayer' not in s:
        s, n = re.subn(r'dependencies\s*\{', lambda m: m.group(0) + dep, s, count=1)
        if n != 1:
            raise SystemExit('build.gradle 里找不到 dependencies 块')
write(gradle, s)

# 5. MainActivity:
#    - 返回键:先问网页(window.__appBack),网页处理了就不动;没处理才退到桌面
#      (远程网页里 Capacitor 的返回事件不可靠,所以不依赖它)
#    - ShortvidNative.fullscreen(on):双击全屏时隐藏状态栏/导航栏
#    - TV:ShortvidTV.setupUrl() + 局域网小服务,手机扫码后把服务器地址发给电视
SETUP_HTML = ('<!doctype html><html><head><meta charset="utf-8">'
              '<meta name="viewport" content="width=device-width,initial-scale=1"><title>设置电视</title>'
              '<style>body{margin:0;background:#0b0b0b;color:#fff;font-family:sans-serif;padding:28px 22px}'
              'h1{font-size:21px}p{color:#999;font-size:14px;line-height:1.7}'
              'input{width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#fff;'
              'border-radius:10px;padding:14px;font-size:16px;margin:14px 0 10px}'
              'button{width:100%;background:#ff4d67;color:#fff;border:0;border-radius:10px;padding:14px;'
              'font-size:16px;font-weight:bold}</style></head><body>'
              '<h1>设置电视的服务器地址</h1>'
              '<p>填写短视频库的网址,提交后电视会自动连接。<br>'
              '在手机上打开短视频库,「我的」页里点「本站地址」可以复制。</p>'
              '<form method="post" action="/"><input name="u" placeholder="例如 http://192.168.0.2:8088" '
              'autocapitalize="off" autocorrect="off" required><button type="submit">发送到电视</button></form>'
              '</body></html>')
DONE_HTML = ('<!doctype html><html><head><meta charset="utf-8">'
             '<meta name="viewport" content="width=device-width,initial-scale=1"><title>已发送</title></head>'
             '<body style="margin:0;background:#0b0b0b;color:#fff;font-family:sans-serif;padding:60px 22px;text-align:center">'
             '<div style="font-size:54px">OK</div><h2>已发送到电视</h2>'
             '<p style="color:#999">电视正在连接服务器,可以关掉这个页面了。</p></body></html>')

JAVA = r'''package __PKG__;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
__TV_IMPORTS__

public class MainActivity extends BridgeActivity {
    private static final String BACK_JS =
        "(function(){try{return window.__appBack?(window.__appBack()?'1':'0'):'x'}catch(e){return 'x'}})()";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new NativeApi(), "ShortvidNative");
__TV_INIT__
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });
    }

    private void handleBack() {
        final WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) {
            moveTaskToBack(true);
            return;
        }
        wv.evaluateJavascript(BACK_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if ("\"1\"".equals(value)) return;
                if ("\"0\"".equals(value)) {
                    moveTaskToBack(true);
                    return;
                }
                if (wv.canGoBack()) wv.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    private void setFullscreen(boolean on) {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (c == null) return;
        if (on) {
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    public class NativeApi {
        @JavascriptInterface
        public void fullscreen(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    setFullscreen(on);
                }
            });
        }
    }
__TV_CODE__
}
'''

TV_IMPORTS = '''import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.Enumeration;
import java.util.Locale;'''

TV_INIT = '''            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            getBridge().getWebView().addJavascriptInterface(new TvApi(), "ShortvidTV");
            startSetupServer();'''

TV_CODE = r'''
    // ---------- TV:局域网「手机扫码设置服务器地址」 ----------
    private SetupServer setupServer;

    private void startSetupServer() {
        SetupServer s = new SetupServer(new SetupServer.Callback() {
            @Override
            public void onUrl(final String url) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (getBridge() == null) return;
                        getBridge().getWebView().evaluateJavascript(
                            "window.__tvSetup&&window.__tvSetup(" + jsQuote(url) + ")", null);
                    }
                });
            }
        });
        if (s.open()) {
            setupServer = s;
            s.start();
        }
    }

    @Override
    public void onDestroy() {
        if (setupServer != null) setupServer.shutdown();
        super.onDestroy();
    }

    public class TvApi {
        @JavascriptInterface
        public String setupUrl() {
            SetupServer s = setupServer;
            String ip = localIp();
            if (s == null || ip == null) return "";
            return "http://" + ip + ":" + s.port + "/";
        }
    }

    static String jsQuote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\');
            if (c < 32 || c == 0x2028 || c == 0x2029) continue;
            b.append(c);
        }
        return b.append('"').toString();
    }

    static String localIp() {
        String fallback = null;
        try {
            Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
            while (en != null && en.hasMoreElements()) {
                NetworkInterface ni = en.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> ad = ni.getInetAddresses();
                while (ad.hasMoreElements()) {
                    InetAddress a = ad.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || !a.isSiteLocalAddress()) continue;
                    String n = ni.getName();
                    if (n != null && (n.startsWith("wlan") || n.startsWith("eth"))) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
        } catch (Exception e) {
            // ignore
        }
        return fallback;
    }

    static class SetupServer extends Thread {
        interface Callback {
            void onUrl(String url);
        }

        static final String PAGE = __SETUP_PAGE__;
        static final String DONE = __DONE_PAGE__;
        final Callback cb;
        ServerSocket ss;
        volatile boolean running = true;
        int port = 0;

        SetupServer(Callback cb) {
            this.cb = cb;
            setDaemon(true);
        }

        boolean open() {
            for (int p = 8899; p < 8910; p++) {
                try {
                    ss = new ServerSocket(p);
                    port = p;
                    return true;
                } catch (IOException e) {
                    // 端口被占用,换下一个
                }
            }
            return false;
        }

        void shutdown() {
            running = false;
            try {
                if (ss != null) ss.close();
            } catch (IOException e) {
                // ignore
            }
        }

        @Override
        public void run() {
            while (running) {
                try {
                    Socket s = ss.accept();
                    s.setSoTimeout(5000);
                    handle(s);
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        }

        void handle(Socket s) {
            try {
                InputStream in = new BufferedInputStream(s.getInputStream());
                String first = readLine(in);
                if (first == null) return;
                int len = 0;
                String line;
                while ((line = readLine(in)) != null && line.length() > 0) {
                    String l = line.toLowerCase(Locale.US);
                    if (l.startsWith("content-length:")) {
                        try {
                            len = Integer.parseInt(l.substring(15).trim());
                        } catch (NumberFormatException e) {
                            len = 0;
                        }
                    }
                }
                String page = PAGE;
                if (first.startsWith("POST")) {
                    byte[] buf = new byte[Math.max(0, Math.min(len, 4096))];
                    int off = 0;
                    while (off < buf.length) {
                        int n = in.read(buf, off, buf.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                    String url = parseUrl(new String(buf, 0, off, "UTF-8"));
                    if (url != null) {
                        page = DONE;
                        cb.onUrl(url);
                    }
                }
                byte[] body = page.getBytes("UTF-8");
                String head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: "
                    + body.length + "\r\nConnection: close\r\n\r\n";
                OutputStream out = s.getOutputStream();
                out.write(head.getBytes("UTF-8"));
                out.write(body);
                out.flush();
            } catch (Exception e) {
                // ignore
            } finally {
                try {
                    s.close();
                } catch (IOException e) {
                    // ignore
                }
            }
        }

        static String parseUrl(String body) throws Exception {
            for (String kv : body.split("&")) {
                int i = kv.indexOf('=');
                if (i > 0 && kv.substring(0, i).equals("u")) {
                    String v = URLDecoder.decode(kv.substring(i + 1), "UTF-8").trim();
                    if (v.length() == 0 || v.length() > 300) return null;
                    if (!v.matches("(?i)^https?://[^\\s\"'<>\\\\]+$") && !v.matches("^[^\\s\"'<>\\\\/:]+(:\\d+)?(/.*)?$")) return null;
                    return v;
                }
            }
            return null;
        }

        static String readLine(InputStream in) throws IOException {
            StringBuilder b = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                if (c == '\n') break;
                if (c != '\r') b.append((char) c);
                if (b.length() > 8192) break;
            }
            if (c == -1 && b.length() == 0) return null;
            return b.toString();
        }
    }
'''


PLAYER_IMPORTS = '''import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.CookieManager;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import java.util.HashMap;
import java.util.Map;'''

PLAYER_INIT = '''            getBridge().getWebView().addJavascriptInterface(new PlayerApi(), "ShortvidPlayer");'''

PLAYER_CODE = r'''
    // ---------- TV:原生播放器(ExoPlayer),画面在网页下面,网页背景透明 ----------
    private ExoPlayer exo;
    private FrameLayout exoBox;
    private SurfaceView exoView;
    private volatile String exoState = "{\"st\":1,\"pos\":0,\"dur\":0,\"pw\":0,\"w\":0,\"h\":0,\"err\":\"\"}";
    private volatile String exoErr = "";
    private volatile boolean exoPending = false;
    private final Handler exoH = new Handler(Looper.getMainLooper());
    private final Runnable exoTick = new Runnable() {
        @Override
        public void run() {
            exoSnapshot();
            exoH.postDelayed(this, 250);
        }
    };

    private static String exoQ(String s) {
        StringBuilder b = new StringBuilder("\"");
        if (s != null) {
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '"' || c == '\\') b.append('\\').append(c);
                else if (c < 32 || c > 126) b.append(' ');
                else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    private void exoSnapshot() {
        if (exo == null || exoPending) return;
        long dur = exo.getDuration();
        VideoSize vs = exo.getVideoSize();
        exoState = "{\"st\":" + exo.getPlaybackState() + ",\"pos\":" + exo.getCurrentPosition()
            + ",\"dur\":" + (dur < 0 ? 0 : dur) + ",\"pw\":" + (exo.getPlayWhenReady() ? 1 : 0)
            + ",\"w\":" + vs.width + ",\"h\":" + vs.height + ",\"err\":" + exoQ(exoErr) + "}";
    }

    private void exoFit(VideoSize vs) {
        if (exoBox == null || exoView == null || vs.width <= 0 || vs.height <= 0) return;
        int bw = exoBox.getWidth(), bh = exoBox.getHeight();
        if (bw <= 0 || bh <= 0) {
            bw = getResources().getDisplayMetrics().widthPixels;
            bh = getResources().getDisplayMetrics().heightPixels;
        }
        float vw = vs.width * (vs.pixelWidthHeightRatio > 0 ? vs.pixelWidthHeightRatio : 1f);
        float sc = Math.min(bw / vw, bh / (float) vs.height);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            Math.max(2, Math.round(vw * sc)), Math.max(2, Math.round(vs.height * sc)), Gravity.CENTER);
        exoView.setLayoutParams(lp);
    }

    private void exoEnsure() {
        if (exo != null) return;
        android.webkit.WebView wv = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) wv.getParent();
        exoBox = new FrameLayout(this);
        exoView = new SurfaceView(this);
        exoBox.addView(exoView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        parent.addView(exoBox, 0, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        wv.setBackgroundColor(Color.TRANSPARENT);
        DefaultRenderersFactory rf = new DefaultRenderersFactory(this).setEnableDecoderFallback(true);
        exo = new ExoPlayer.Builder(this, rf).build();
        exo.setVideoSurfaceView(exoView);
        exo.addListener(new Player.Listener() {
            @Override
            public void onVideoSizeChanged(VideoSize vs) {
                exoFit(vs);
            }

            @Override
            public void onPlayerError(PlaybackException e) {
                Throwable c = e.getCause();
                exoErr = e.getErrorCodeName() + (c != null ? " " + c.getClass().getSimpleName() + ":" + c.getMessage() : "");
                exoSnapshot();
            }
        });
        exoH.post(exoTick);
    }

    private void exoRelease() {
        exoH.removeCallbacks(exoTick);
        if (exo != null) {
            try { exo.release(); } catch (Exception e) { /* ignore */ }
            exo = null;
        }
    }

    public class PlayerApi {
        @JavascriptInterface
        public boolean available() {
            return true;
        }

        @JavascriptInterface
        public void open(final String url, final long startMs) {
            exoErr = "";
            exoPending = true;
            exoState = "{\"st\":1,\"pos\":0,\"dur\":0,\"pw\":0,\"w\":0,\"h\":0,\"err\":\"\"}";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        exoEnsure();
                        String cookie = CookieManager.getInstance().getCookie(url);
                        DefaultHttpDataSource.Factory f = new DefaultHttpDataSource.Factory()
                            .setAllowCrossProtocolRedirects(true)
                            .setConnectTimeoutMs(15000)
                            .setReadTimeoutMs(600000);
                        if (cookie != null) {
                            Map<String, String> h = new HashMap<String, String>();
                            h.put("Cookie", cookie);
                            f.setDefaultRequestProperties(h);
                        }
                        exo.setPlayWhenReady(false);
                        exo.setMediaSource(new DefaultMediaSourceFactory(f).createMediaSource(MediaItem.fromUri(url)));
                        exo.prepare();
                        if (startMs > 0) exo.seekTo(startMs);
                        exoBox.setVisibility(android.view.View.VISIBLE);
                    } catch (Exception e) {
                        exoErr = "open " + e.getClass().getSimpleName() + ":" + e.getMessage();
                    } finally {
                        exoPending = false;
                        exoSnapshot();
                    }
                }
            });
        }

        @JavascriptInterface
        public void play() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (exo != null) exo.setPlayWhenReady(true);
                }
            });
        }

        @JavascriptInterface
        public void pause() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (exo != null) exo.setPlayWhenReady(false);
                }
            });
        }

        @JavascriptInterface
        public void seek(final long ms) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (exo != null) exo.seekTo(Math.max(0, ms));
                }
            });
        }

        @JavascriptInterface
        public void close() {
            exoState = "{\"st\":1,\"pos\":0,\"dur\":0,\"pw\":0,\"w\":0,\"h\":0,\"err\":\"\"}";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (exo != null) {
                        exo.stop();
                        exo.clearMediaItems();
                    }
                    if (exoBox != null) exoBox.setVisibility(android.view.View.GONE);
                }
            });
        }

        @JavascriptInterface
        public String state() {
            return exoState;
        }
    }
'''


def jstr(text):
    """转成 Java 字符串字面量(ASCII + \\uXXXX,避免编译器编码问题)。"""
    return json.dumps(text, ensure_ascii=True)


java = JAVA
if IS_TV:
    tv_code = TV_CODE.replace('__SETUP_PAGE__', jstr(SETUP_HTML)).replace('__DONE_PAGE__', jstr(DONE_HTML))
    tv_code = tv_code.replace('if (setupServer != null) setupServer.shutdown();',
                              'if (setupServer != null) setupServer.shutdown();\n        exoRelease();', 1)
    java = (java.replace('__TV_IMPORTS__', TV_IMPORTS + '\n' + PLAYER_IMPORTS)
            .replace('__TV_INIT__', TV_INIT + '\n' + PLAYER_INIT)
            .replace('__TV_CODE__', tv_code + PLAYER_CODE))
else:
    java = java.replace('__TV_IMPORTS__', '').replace('__TV_INIT__', '').replace('__TV_CODE__', '')

java_root = os.path.join(root, 'src', 'main', 'java')
target = None
for dp, _, names in os.walk(java_root):
    if 'MainActivity.java' in names:
        target = os.path.join(dp, 'MainActivity.java')
if target is None:
    raise SystemExit('找不到 MainActivity.java')
pkg = re.search(r'^package\s+([\w.]+);', read(target), re.M).group(1)
java = java.replace('__PKG__', pkg)
write(target, ''.join(ch if ord(ch) < 128 else '\\u%04x' % ord(ch) for ch in java))

print('patched android project: variant', variant, 'version', version_name, version_code)
