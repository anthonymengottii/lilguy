// Generate lark-artifact.html from lark.js + behavior.js + the page wiring.
//
//   node tools/build-artifact.js
//
// The artifact page cannot use modules: its CSP blocks fetch, so the data arrives through
// <script src> as globals and the engine has to be inline. That used to mean a hand-pasted copy of
// both modules inside the HTML, which drifted — by the time this script was written the copy's draw()
// cleared the canvas unconditionally while the module's did not, and behavior.js had gained a method
// the page had never received. Generating the page removes the possibility.
//
// No bundler: the transform is "drop the module keywords", and two anchored line-level rules cover
// every occurrence in both files. Anything more clever would be harder to audit than the drift it
// replaces.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'lark-artifact.html');

const BANNER = `// =============================================================================================
// GENERATED FILE — DO NOT EDIT.
//
// Built by tools/build-artifact.js from lark.js, behavior.js and tools/artifact-page.js, wrapped in
// tools/artifact-template.html. Edit those and re-run \`npm run build\`; editing this file loses the
// change on the next build, and test/build.spec.js fails if the two ever disagree.
// =============================================================================================`;

// Strip ES module syntax. Anchored to the start of a line so a matching string inside a comment or a
// template literal is untouched.
function stripModuleSyntax(src, label) {
  const lines = src.split(/\r?\n/);
  let removed = 0, rewritten = 0;
  const out = lines.filter((line) => {
    // `export { a, b };` — the re-export list at the end of lark.js carries no runtime meaning here.
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) { removed++; return false; }
    // A bare `import ...` would mean the page needs a module graph, which it cannot have.
    if (/^import\s/.test(line)) {
      throw new Error(`${label}: cannot inline a file with a top-level import:\n  ${line}`);
    }
    return true;
  }).map((line) => {
    // `export class Foo` / `export function foo` / `export const FOO` -> drop the keyword.
    const next = line.replace(/^export\s+(class|function|const|let|var|async)\b/, '$1');
    if (next !== line) rewritten++;
    return next;
  });
  return { code: out.join('\n'), removed, rewritten };
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`missing input: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

const lark = stripModuleSyntax(read('lark.js'), 'lark.js');
const behavior = stripModuleSyntax(read('behavior.js'), 'behavior.js');
const page = read('tools/artifact-page.js');
const template = read('tools/artifact-template.html');

const MARKERS = {
  '<!--INJECT:lark-->': `${BANNER}\n\n${lark.code}`,
  '<!--INJECT:behavior-->': behavior.code,
  '<!--INJECT:page-->': page,
};

let html = template;
for (const [marker, code] of Object.entries(MARKERS)) {
  if (!html.includes(marker)) throw new Error(`template is missing marker ${marker}`);
  // A function replacer, so a `$&` or `$1` inside the injected code is not treated as a backreference.
  html = html.replace(marker, () => code);
}

// Guards. Each one corresponds to a way the generated page could be broken while still looking fine.
const problems = [];
if (/^\s*(export|import)\s/m.test(html)) problems.push('module syntax survived the strip');
if (!html.includes('<script src="anim_data.js">')) problems.push('anim_data.js script tag lost');
if (!html.includes('<script src="behavior_data.js">')) problems.push('behavior_data.js script tag lost');
if (!/new LarkRuntime\(/.test(html)) problems.push('page wiring does not construct LarkRuntime');
if (!/new BehaviorRunner\(/.test(html)) problems.push('page wiring does not construct BehaviorRunner');
if (!/clearRect/.test(html)) problems.push("nothing clears the canvas — the module's draw() does not");
if (problems.length) {
  console.error('build refused:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
fs.writeFileSync(OUT, html);
console.log(
  `wrote lark-artifact.html (${(html.length / 1024).toFixed(1)} KB)\n` +
  `  lark.js:     ${lark.rewritten} export keywords dropped, ${lark.removed} export lists removed\n` +
  `  behavior.js: ${behavior.rewritten} export keywords dropped, ${behavior.removed} export lists removed\n` +
  `  ${before === html ? 'unchanged' : before === null ? 'created' : 'updated'}`
);
