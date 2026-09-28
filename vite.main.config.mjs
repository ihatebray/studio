import { defineConfig } from 'vite';

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
