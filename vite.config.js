import { defineConfig } from 'vite';

/**
 * A backtick inside a GLSL template literal has taken this build down eight
 * times, by six different authors. It is a uniquely bad failure: the shader
 * source is a template literal, so a stray backtick — almost always in a
 * comment written *about* a hex colour or a GLSL identifier — silently closes
 * the string, and what the browser reports is a syntax error hundreds of lines
 * away from anything that looks wrong. The eighth one reached the player.
 *
 * This does not try to detect the bug by tracking template literals itself.
 * I wrote that version first and it false-positived on 16 of 74 files, because
 * doing it correctly means tokenising JS — regexes, quoted strings and ordinary
 * comments all contain backticks legitimately. Instead: let esbuild parse the
 * file, which is exact, and only when it *fails* run the heuristic to say what
 * the likely cause is. Detection stays perfect; the plugin only improves the
 * message, which is the part that was actually costing people time.
 */
function glslBacktickGuard() {
  let esbuild = null;
  return {
    name: 'glsl-backtick-guard',
    apply: 'serve',
    enforce: 'pre',
    async buildStart() { esbuild ??= await import('esbuild'); },
    async transform(code, id) {
      if (!id.includes('/src/') || !/\.m?js(\?|$)/.test(id)) return null;
      if (!code.includes('`')) return null;
      esbuild ??= await import('esbuild');

      try {
        await esbuild.transform(code, { loader: 'js', format: 'esm' });
        return null;                      // parses: nothing to say
      } catch (parseErr) {
        // It is broken. Is it *this* bug? A backtick on a line that is a
        // comment is the signature; in normal code a backtick opens a string
        // and comments do not contain them by accident.
        const suspects = [];
        code.split('\n').forEach((ln, i) => {
          if (/^\s*(?:\/\/|\*|\/\*)/.test(ln) && ln.includes('`')) suspects.push(i + 1);
        });
        const rel = id.slice(id.lastIndexOf('/src/') + 1).replace(/\?.*$/, '');
        if (!suspects.length) return null;  // some other syntax error; let vite report it

        throw new Error(
          `${rel} does not parse, and there is a backtick in a comment on ` +
          `line ${suspects.join(', line ')}.\n` +
          `  If that comment is inside a GLSL template literal, the backtick closed the ` +
          `string — that is the cause, not wherever the parser gave up ` +
          `(${String(parseErr.message).split('\n')[0]}).\n` +
          `  Use single quotes when writing prose about a hex colour or an identifier ` +
          `inside a shader. This is the ninth occurrence of this bug on this project.`
        );
      }
    },
  };
}

/**
 * Keep the .pab world bakes out of dist/.
 *
 * Cloudflare Pages and Workers both reject any single static asset over
 * 25 MiB, and public/bakes/world-20261018-1536-*.pab — the default the game
 * loads, since WORLD.heightmapRes is 1536 — is 32 MB. Vite copies public/
 * into dist/ verbatim, so a plain `npm run build` walks straight into that
 * limit. The bakes are hosted on R2 instead and reached through
 * VITE_BAKE_BASE_URL (see src/main.js and docs/DEPLOY.md).
 *
 * `apply: 'build'` is the inverse of the guard above: dev must keep serving
 * the bakes from public/bakes/ exactly as it does today, because every capture
 * harness in tools/ depends on that and a live bake costs ~25 s of CPU per run.
 *
 * The deletion happens in closeBundle rather than by filtering the copy,
 * because Vite copies publicDir wholesale with no per-file hook. manifest.json
 * is deliberately left in place: it is 480 bytes, and a build with no
 * VITE_BAKE_BASE_URL set (a local `npm run preview`, say) still wants it.
 */
function excludeBakesFromBuild() {
  let outDir = 'dist';
  return {
    name: 'exclude-bakes-from-build',
    apply: 'build',
    configResolved(cfg) { outDir = cfg.build.outDir; },
    async closeBundle() {
      const { readdir, stat, unlink } = await import('node:fs/promises');
      const { join, resolve } = await import('node:path');
      const dir = resolve(outDir, 'bakes');
      let names;
      try { names = await readdir(dir); } catch { return; }   // nothing copied
      let n = 0, bytes = 0;
      for (const name of names) {
        if (!name.endsWith('.pab')) continue;
        const p = join(dir, name);
        bytes += (await stat(p)).size;
        await unlink(p);
        n++;
      }
      if (n) {
        this.info(`excluded ${n} .pab bake(s), ${(bytes / 1048576).toFixed(1)} MB, ` +
                  `from ${outDir}/bakes — serve them from VITE_BAKE_BASE_URL`);
      }
    },
  };
}

/**
 * Fail the build if any single file in dist/ would be rejected by Cloudflare's
 * 25 MiB per-asset cap. This is the check that would have caught the 32 MB
 * bake before a deploy did, and it stays useful for whatever large asset shows
 * up next. Build-only, and it runs after the exclusion above.
 */
function assetSizeCap(limitBytes = 25 * 1024 * 1024) {
  let outDir = 'dist';
  return {
    name: 'asset-size-cap',
    apply: 'build',
    enforce: 'post',
    configResolved(cfg) { outDir = cfg.build.outDir; },
    async closeBundle() {
      const { readdir, stat } = await import('node:fs/promises');
      const { join, resolve, relative } = await import('node:path');
      const root = resolve(outDir);
      const over = [];
      async function walk(dir) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else {
            const { size } = await stat(p);
            if (size > limitBytes) over.push(`${relative(root, p)} (${(size / 1048576).toFixed(1)} MB)`);
          }
        }
      }
      await walk(root);
      if (over.length) {
        this.error(
          `${over.length} file(s) in ${outDir}/ exceed Cloudflare's 25 MiB per-asset limit ` +
          `and the deploy will be rejected:\n  ${over.join('\n  ')}\n` +
          `  Host the file off the bundle (see docs/DEPLOY.md) rather than shrinking it.`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [glslBacktickGuard(), excludeBakesFromBuild(), assetSizeCap()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
