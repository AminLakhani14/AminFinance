/**
 * AminFinance for Android — the web frontend, bundled into the app.
 *
 * The screen is the same React app the browser runs (built from the unchanged
 * client/ by `npm run build:web`), so it looks and works the same. It is
 * shipped inside the APK and served to the WebView at http://localhost:5173 by
 * a small native hook (patches/react-native-webview+*.patch): no server, no
 * download, and an origin the deployed backend's CORS list already accepts.
 *
 * What this file adds is the part a browser would otherwise provide:
 *
 *  - the hardware back button walks back through the app's pages;
 *  - links to other sites open in the phone's browser, not inside the app;
 *  - Excel, PDF and CSV exports, which the web app hands to the browser as
 *    blob downloads a WebView cannot save, go to Android's share sheet;
 *  - the splash screen stays up until the app has painted;
 *  - a crashed WebView renderer reloads instead of leaving a blank screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewMessageEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as SplashScreen from 'expo-splash-screen';

/** Where the bundled frontend is served. Must match the native patch. */
const APP_ORIGIN = 'http://localhost:5173';
const APP_URL = `${APP_ORIGIN}/`;
/** The web app's dark background, so nothing flashes white around it. */
const BACKGROUND = '#0a0b1e';
/** Longest the splash may stay up if the page never reports a finished load. */
const SPLASH_TIMEOUT_MS = 8_000;

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Injected before the web app runs: routes blob downloads to the app.
 *
 * The web app saves exports by creating an object URL for a Blob and clicking
 * a hidden <a download>. A WebView silently ignores that, so the Blob behind
 * the URL is remembered, and the click is turned into a message carrying the
 * file as base64, which the native side writes and shares.
 */
const DOWNLOAD_BRIDGE = `
(function () {
  if (window.__aminfinanceDownloads) return;
  window.__aminfinanceDownloads = true;
  var blobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (object) {
    var url = createObjectURL(object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  function send(blob, name) {
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'download',
        name: name,
        mime: blob.type || 'application/octet-stream',
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1)
      }));
    };
    reader.readAsDataURL(blob);
  }
  function handle(anchor) {
    var href = anchor.href || '';
    if (!anchor.hasAttribute('download') || href.indexOf('blob:') !== 0) return false;
    var blob = blobs.get(href);
    if (!blob) return false;
    blobs.delete(href);
    send(blob, anchor.getAttribute('download') || 'download');
    return true;
  }
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (handle(this)) return;
    return click.call(this);
  };
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest && event.target.closest('a[download]');
    if (anchor && handle(anchor)) event.preventDefault();
  }, true);
})();
true;
`;

/**
 * Phone-only layout adjustments, injected rather than edited into client/.
 *
 * Two things the web layout gets wrong at phone width, both fixed here for
 * screens under 768px only — wider screens are untouched:
 *
 *  - the bottom navigation fits ten items into ~35px each and runs the labels
 *    together; it now scrolls sideways with every label readable;
 *  - single-column card grids widen to their content and push cards past the
 *    screen edge; grid items may now shrink to the screen.
 */
const MOBILE_STYLES = `
(function () {
  if (document.getElementById('aminfinance-mobile-styles')) return;
  var style = document.createElement('style');
  style.id = 'aminfinance-mobile-styles';
  style.textContent = [
    '@media (max-width: 767px) {',
    '  aside nav { justify-content: flex-start !important; overflow-x: auto; gap: 2px;',
    '    scrollbar-width: none; -webkit-overflow-scrolling: touch; }',
    '  aside nav::-webkit-scrollbar { display: none; }',
    '  aside nav > a { flex: 0 0 auto; min-width: 66px; padding-left: 8px !important; padding-right: 8px !important; }',
    // A single-column grid sizes its column to its widest content, which on
    // a phone pushes cards (the expense sheet) past the screen edge. Letting
    // grid items shrink keeps every card inside the screen.
    '  main .grid > * { min-width: 0; }',
    '}'
  ].join('\\n');
  // This runs as the page starts, which can be before <html> exists; the
  // style is attached the moment there is somewhere to put it.
  function attach() {
    var target = document.head || document.documentElement;
    if (!target) return false;
    target.appendChild(style);
    return true;
  }
  if (!attach()) {
    new MutationObserver(function (_, observer) {
      if (attach()) observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  }
})();
`;

/** The app's own pages, and the in-page URL kinds the web app creates. */
function isAppUrl(url: string): boolean {
  return (
    url === APP_ORIGIN ||
    url.startsWith(`${APP_ORIGIN}/`) ||
    url.startsWith('about:') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')
  );
}

/** A name Android's file system and the share sheet both accept. */
function safeFileName(name: unknown): string {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.slice(0, 120) || 'download';
}

interface DownloadMessage {
  type: 'download';
  name: string;
  mime: string;
  base64: string;
}

function isDownload(value: unknown): value is DownloadMessage {
  const v = value as Partial<DownloadMessage> | null;
  return v?.type === 'download' && typeof v.base64 === 'string';
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const webview = useRef<WebView>(null);
  const canGoBack = useRef(false);
  // Remounting the WebView is how it reloads after a renderer crash or a
  // failed first load — a fresh view rather than a reload of a dead one.
  const [mountKey, setMountKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack.current) return false; // Leave the app, as Android expects.
      webview.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void SplashScreen.hideAsync().catch(() => undefined), SPLASH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const onShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
    if (isAppUrl(request.url)) return true;
    // A news article, an issuer's site, a docs link: the phone's browser.
    void Linking.openURL(request.url).catch(() => undefined);
    return false;
  }, []);

  const onMessage = useCallback(async (event: WebViewMessageEvent) => {
    let message: unknown;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!isDownload(message)) return;

    try {
      const file = new File(Paths.cache, safeFileName(message.name));
      if (file.exists) file.delete();
      file.create();
      file.write(message.base64, { encoding: 'base64' });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: message.mime, dialogTitle: message.name });
      }
    } catch {
      // Nothing useful to show from native code; the web app keeps working.
    }
  }, []);

  const onNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
    canGoBack.current = navigation.canGoBack;
  }, []);

  const reload = useCallback(() => {
    setLoadError(null);
    setMountKey((key) => key + 1);
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style="light" />
      {loadError ? (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>AminFinance could not start</Text>
          <Text style={styles.errorDetail}>{loadError}</Text>
          <Pressable style={styles.button} onPress={reload}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          key={mountKey}
          ref={webview}
          source={{ uri: APP_URL }}
          style={styles.web}
          containerStyle={styles.web}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          // The cosmic background is a muted, looping video.
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // target="_blank" links come back through onShouldStartLoadWithRequest
          // instead of opening an invisible second window.
          setSupportMultipleWindows={false}
          // The phone's font-size setting would otherwise rescale the layout.
          textZoom={100}
          overScrollMode="never"
          setBuiltInZoomControls={false}
          allowFileAccess={false}
          // Each piece in its own try, so one failing cannot stop the other.
          injectedJavaScriptBeforeContentLoaded={[MOBILE_STYLES, DOWNLOAD_BRIDGE]
            .map((script) => `try {${script}} catch (e) {}`)
            .join('\n')}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onNavigationStateChange={onNavigationStateChange}
          onLoadEnd={() => void SplashScreen.hideAsync().catch(() => undefined)}
          onRenderProcessGone={reload}
          onError={(event) => setLoadError(event.nativeEvent.description || 'The app page failed to load.')}
          webviewDebuggingEnabled={__DEV__}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  web: { flex: 1, backgroundColor: BACKGROUND },
  error: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  errorTitle: { color: '#f4f6ff', fontSize: 18, fontWeight: '600' },
  errorDetail: { color: '#9aa3c7', fontSize: 14, textAlign: 'center' },
  button: { marginTop: 8, borderRadius: 12, backgroundColor: '#2f6fd6', paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
