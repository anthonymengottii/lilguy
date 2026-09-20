import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SIM = path.resolve(HERE, '..');

// This app is deliberately walled off from the rest of web-sim: its own package.json, its own
// node_modules, its own build. web-sim proper has NO runtime dependencies -- lark.js is a plain
// module and the harnesses are plain Node -- and that is worth keeping, because it is the thing the
// firmware port is measured against. An editor that breaks must not be able to break the instrument.
//
// It reaches OUT for exactly two files, both read-only and both INSIDE THE REPOSITORY:
//
//   ../lark.js        the real runtime, imported not reimplemented
//   ../anim_data.js   the scene data (see src/animData.js for why it is that copy)
//
// It used to alias `@data` to ../../../lilguy-fork/public, which is outside the repo and checked in
// nowhere. That builds on a machine with the fork sitting beside it and nowhere else: a Vercel
// build failed with `Could not load /vercel/lilguy-fork/public/anim_data.json`, and so would any
// fresh clone. Nothing here may point outside WEB_SIM.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8795,          // 8793 serves the reference, 8794 serves web-sim; this is the next one
    fs: { allow: [HERE, WEB_SIM] },
  },
  resolve: {
    alias: {
      '@lark': path.join(WEB_SIM, 'lark.js'),
    },
  },
});
