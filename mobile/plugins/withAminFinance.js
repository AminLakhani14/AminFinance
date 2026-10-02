/**
 * Android build wiring for the AminFinance app, applied on every
 * `expo prebuild` — the android/ folder is generated, so anything it needs
 * lives here rather than in hand-edited native files.
 *
 *  1. Bundles the web frontend: copies mobile/web-dist (built by
 *     `npm run build:web` from the unchanged client/) into the APK's
 *     assets/www, where the patched WebView serves it at http://localhost:5173.
 *  2. Allows cleartext HTTP for localhost only. Those requests never reach the
 *     network — the WebView answers them from the APK — but Android checks the
 *     scheme before that, and the app's origin must be http://localhost:5173 to
 *     match what the backend's CORS list allows. Every real host stays HTTPS.
 *  3. Signs release builds with the app's own key when one is supplied
 *     (see scripts/build-apk.mjs), so updates install over earlier versions.
 *  4. Builds for ARM phones only, which is every Android phone in practice,
 *     keeping the APK and the build time down.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');

const WEB_DIST = path.join(__dirname, '..', 'web-dist');

function withBundledWebApp(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
        throw new Error(
          'mobile/web-dist/index.html is missing. Run `npm run build:web` before prebuilding.',
        );
      }
      const target = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'www');
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(WEB_DIST, target, { recursive: true });
      // A Netlify rewrite file; meaningless inside the APK.
      fs.rmSync(path.join(target, '_redirects'), { force: true });
      return cfg;
    },
  ]);
}

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Cleartext only for the app's own bundled frontend at http://localhost:5173,
     which the WebView serves from the APK without touching the network. -->
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

function withLocalhostCleartext(config) {
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'network_security_config.xml'), NETWORK_SECURITY_CONFIG);
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });
}

const SIGNING_MARKER = '// AminFinance release signing';

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes(SIGNING_MARKER)) return cfg;

    // A release signing config fed by Gradle properties (build-apk.mjs sets them
    // as ORG_GRADLE_PROJECT_* variables), so the key's passwords
    // live outside the repository.
    gradle = gradle.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        ${SIGNING_MARKER}
        release {
            if (project.hasProperty('aminfinanceStoreFile')) {
                storeFile file(project.property('aminfinanceStoreFile'))
                storePassword project.property('aminfinanceStorePassword')
                keyAlias project.property('aminfinanceKeyAlias')
                keyPassword project.property('aminfinanceKeyPassword')
            }
        }`,
    );

    // The template signs release builds with the debug key; use the app key
    // whenever one was supplied.
    gradle = gradle.replace(
      /(release\s*\{[^{}]*?)signingConfig\s+signingConfigs\.debug/,
      `$1signingConfig project.hasProperty('aminfinanceStoreFile') ? signingConfigs.release : signingConfigs.debug`,
    );

    cfg.modResults.contents = gradle;
    return cfg;
  });
}

function withArmOnly(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults.filter((p) => !(p.type === 'property' && p.key === 'reactNativeArchitectures'));
    props.push({ type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a' });
    cfg.modResults = props;
    return cfg;
  });
}

module.exports = function withAminFinance(config) {
  config = withBundledWebApp(config);
  config = withLocalhostCleartext(config);
  config = withReleaseSigning(config);
  config = withArmOnly(config);
  return config;
};
