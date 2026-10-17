#!/usr/bin/env node
// A separate process contains parser crashes and gives the parent an exit code
// that cannot be confused with Node's ordinary uncaught-error exit of 1.

const VALID = 0;
const INVALID = 65;
const CANNOT_DECIDE = 3;

function cannotDecide(message) {
  console.error(`adlc syntax check: ${message}`);
  process.exit(CANNOT_DECIDE);
}

try {
  const [{ readFileSync }, { createRequire }, { dirname, extname, join }, { resolveTypeScript }] = await Promise.all([
    import('node:fs'),
    import('node:module'),
    import('node:path'),
    import('./syntax.mjs'),
  ]);
  const file = process.argv[2];
  if (!file) cannotDecide('no file was provided');
  const resolved = resolveTypeScript(file);
  if (resolved === null) cannotDecide(`typescript could not be resolved from ${file}`);

  const ts = createRequire(import.meta.url)(resolved.path);
  const name = join(dirname(file), `.__adlc_syntax__${extname(file).toLowerCase()}`);
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const host = {
    getSourceFile: (candidate) => candidate === name ? sourceFile : undefined,
    fileExists: (candidate) => candidate === name,
    readFile: (candidate) => candidate === name ? text : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => dirname(file),
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  const held = program.getSourceFile(name);
  if (held === undefined) cannotDecide(`typescript did not retain ${file}`);
  process.exit(program.getSyntacticDiagnostics(held).length === 0 ? VALID : INVALID);
} catch (err) {
  cannotDecide(err instanceof Error ? err.message : String(err));
}
