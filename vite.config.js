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

export default defineConfig({
  plugins: [glslBacktickGuard()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
