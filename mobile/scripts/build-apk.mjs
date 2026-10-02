#!/usr/bin/env node
/**
 * Builds the release APK, end to end:
 *
 *   1. the web frontend, from the unchanged client/ (npm run build:web);
 *   2. the native Android project, regenerated from app.json and plugins/;
 *   3. a release signing key, created once and kept in mobile/keystore/;
 *   4. Gradle's assembleRelease;
 *   5. a copy of the APK at mobile/dist/AminFinance-<version>.apk.
 *
 * Needs a JDK 17 and the Android SDK. JAVA_HOME and ANDROID_HOME are used when
 * set; otherwise the locations scripts/setup-android-toolchain.sh installs to.
 *
 * Keep mobile/keystore/ safe and out of git (it is ignored): Android only
 * installs an update over an existing install when both are signed by the
 * same key, so losing it means uninstalling — and losing the app's local
 * data — before the next version can go on.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';

const javaHome = process.env.JAVA_HOME || path.join(os.homedir(), 'AndroidBuild', 'jdk-17');
const androidHome =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (isWindows
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
    : path.join(os.homedir(), 'Android', 'Sdk'));

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function step(title) {
  console.log(`\n▶ ${title}`);
}

/** Runs a command; on failure names it without its arguments, which can hold secrets. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: isWindows, ...options });
  if (result.status !== 0) fail(`${path.basename(command)} exited with ${result.status ?? result.signal}`);
}

const javaBin = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
if (!existsSync(javaBin)) {
  fail(`No JDK at ${javaHome}. Set JAVA_HOME, or run scripts/setup-android-toolchain.sh.`);
}
if (!existsSync(path.join(androidHome, 'platform-tools'))) {
  fail(`No Android SDK at ${androidHome}. Set ANDROID_HOME, or run scripts/setup-android-toolchain.sh.`);
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  CI: '1',
};

step('Building the web frontend into mobile/web-dist');
run('npm', ['run', 'build:web'], { cwd: mobileDir, env });

step('Generating the Android project');
run('npx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], { cwd: mobileDir, env });

step('Preparing the release signing key');
const keystoreDir = path.join(mobileDir, 'keystore');
const keystoreFile = path.join(keystoreDir, 'aminfinance-release.p12');
const keystoreProps = path.join(keystoreDir, 'keystore.properties');
if (!existsSync(keystoreFile)) {
  mkdirSync(keystoreDir, { recursive: true });
  // PKCS12 uses one password for the store and the key. keytool reads it from
  // the environment, so it never appears in a process listing.
  const password = randomBytes(18).toString('base64url');
  run(
    path.join(javaHome, 'bin', isWindows ? 'keytool.exe' : 'keytool'),
    [
      '-genkeypair', '-noprompt',
      '-storetype', 'PKCS12',
      '-keystore', keystoreFile,
      '-alias', 'aminfinance',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-storepass:env', 'AMINFINANCE_KEYSTORE_PASSWORD',
      '-keypass:env', 'AMINFINANCE_KEYSTORE_PASSWORD',
      '-dname', 'CN=AminFinance, O=AminFinance, C=PK',
    ],
    { env: { ...env, AMINFINANCE_KEYSTORE_PASSWORD: password }, shell: false },
  );
  writeFileSync(keystoreProps, `storePassword=${password}\nkeyAlias=aminfinance\n`);
  console.log(`  created ${path.relative(mobileDir, keystoreFile)} — back this folder up`);
} else {
  console.log(`  using ${path.relative(mobileDir, keystoreFile)}`);
}
const signing = Object.fromEntries(
  readFileSync(keystoreProps, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);

// Gradle reads the SDK location from local.properties; backslashes and the
// drive colon must be escaped in a .properties file.
writeFileSync(
  path.join(mobileDir, 'android', 'local.properties'),
  `sdk.dir=${androidHome.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`,
);

step('Building the release APK with Gradle');
const androidDir = path.join(mobileDir, 'android');
// The full path: cmd does not always look in the working directory
// (NoDefaultCurrentDirectoryInExePath), and quoted for a path with spaces.
const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
// Gradle turns ORG_GRADLE_PROJECT_<name> variables into project properties;
// passing the signing details this way keeps them off the command line.
run(isWindows ? `"${gradlew}"` : gradlew, ['assembleRelease', '--no-daemon'], {
  cwd: androidDir,
  env: {
    ...env,
    ORG_GRADLE_PROJECT_aminfinanceStoreFile: keystoreFile,
    ORG_GRADLE_PROJECT_aminfinanceStorePassword: signing.storePassword,
    ORG_GRADLE_PROJECT_aminfinanceKeyAlias: signing.keyAlias,
    ORG_GRADLE_PROJECT_aminfinanceKeyPassword: signing.storePassword,
  },
});

const built = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!existsSync(built)) fail(`Gradle finished but ${built} is missing.`);
const version = JSON.parse(readFileSync(path.join(mobileDir, 'app.json'), 'utf8')).expo.version;
const distDir = path.join(mobileDir, 'dist');
mkdirSync(distDir, { recursive: true });
const output = path.join(distDir, `AminFinance-${version}.apk`);
copyFileSync(built, output);
console.log(`\n✔ APK ready: ${output}\n`);
