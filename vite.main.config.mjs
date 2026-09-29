import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

/* The in-app restart (the reload button beside Settings, Ctrl+Shift+R).
   Under `npm start` this config runs inside Forge, which restarts the app
   when "rs" is typed in its terminal. The app can't type there, so it
   touches a file instead, and this turns that into the same "rs". The path
   reaches the app through the environment Forge launches it with. Only in
   watch mode (`npm start`), never in a packaged build. */
function inAppRestart() {
  return {
    name: 'studio:in-app-restart',
    configResolved(config) {
      if (!config.build.watch || globalThis.__studioRestartHook) return;
      globalThis.__studioRestartHook = true;
      const file = path.resolve('.vite', 'restart-request');
      process.env.STUDIO_RESTART_FILE = file;
      fs.watchFile(file, { interval: 300 }, (cur, prev) => {
        if (cur.mtimeMs && cur.mtimeMs !== prev.mtimeMs) process.stdin.emit('data', Buffer.from('rs\n'));
      });
    },
  };
}

// Main-process build. Node built-ins and native/binary-adjacent deps stay
// external so they're require()d from node_modules at runtime instead of
// being bundled (sql.js loads a wasm/asm module, soulseek-ts opens sockets).
//
// IMPORTANT: these are regexes, not plain strings, so SUBPATH imports stay
// external too — libraryDb.js does `import('sql.js/dist/sql-asm.js')`, and a
// plain 'sql.js' string external would NOT match that, causing Vite to
// inline sql.js's UMD file into the bundle where `module.exports` doesn't
// exist ("Cannot set properties of undefined (setting 'exports')").
export default defineConfig({
  plugins: [inAppRestart()],
  build: {
    rollupOptions: {
      external: [
        'electron',
        /^electron\//,
        /^electron-squirrel-startup(\/|$)/,
        /^music-metadata(\/|$)/,
        /^node-id3(\/|$)/,
        /^sql\.js(\/|$)/,
        /^soulseek-ts(\/|$)/,
        /^@ryuziii\/discord-rpc(\/|$)/,
        /^update-electron-app(\/|$)/,
      ],
    },
  },
});
