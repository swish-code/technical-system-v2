import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the EXISTING web system into a native Android app.
 * It does not rebuild anything — `server.url` loads the live site directly,
 * so the app always shows the latest deploy and every API/WebSocket URL
 * resolves exactly as it does in the browser (zero frontend changes).
 *
 * IMPORTANT: set `server.url` to your Railway production URL before building
 * (e.g. https://technical-system-v2-production.up.railway.app).
 */
const config: CapacitorConfig = {
  appId: 'net.swishhh.techsystem',
  appName: 'Swish Menu',
  webDir: 'dist',
  server: {
    url: 'https://technical-system-v2-production.up.railway.app',
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    // Allow the webview to keep the session cookie across launches.
    webContentsDebuggingEnabled: false,
  },
};

export default config;
