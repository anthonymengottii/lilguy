// The scene data, from the copy that is IN THE REPOSITORY.
//
// It used to be imported from `../../../lilguy-fork/public/anim_data.json`, which is the file
// tools/lark_pack.py reads — and which is not checked in anywhere. That worked on a machine with
// the fork sitting beside the repo and could not work anywhere else: a Vercel build failed with
// `Could not load /vercel/lilguy-fork/public/anim_data.json`, and so would any fresh clone.
//
// `web-sim/anim_data.js` is the same data, tracked, already used by the published artifact page.
// Verified equal: all 36 states and all 15 clips compare identical between the two; the source
// JSON carries three extra top-level metadata fields (`id`, `version`, `createdAt`) that nothing
// reads.
//
// It ships as `const ANIM_DATA = {...}` with no export, because the artifact page loads it through
// a <script src> as a global — its CSP blocks modules. Vite has no way to import that, so the text
// is read at build time and parsed here. `?raw` is a Vite import, resolved by the bundler, so this
// costs one parse at startup and nothing at runtime.
import source from '../../anim_data.js?raw';

const match = /^const ANIM_DATA\s*=\s*([\s\S]*?);?\s*$/.exec(source.trim());
if (!match) {
  throw new Error(
    'web-sim/anim_data.js is not in the expected `const ANIM_DATA = {...}` shape. '
    + 'It is generated from the site\'s anim_data.json; regenerate it or update this parser.',
  );
}

const ANIM_DATA = JSON.parse(match[1]);

// A shape check rather than a silent empty editor: an editor with no states renders a blank stage
// and no clips, which looks like a rendering bug rather than a data one.
if (!ANIM_DATA.states || !ANIM_DATA.animations) {
  throw new Error('anim_data is missing `states` or `animations`');
}

export default ANIM_DATA;
