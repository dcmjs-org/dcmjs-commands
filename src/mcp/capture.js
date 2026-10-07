// src/mcp/capture.js
//
// Run a DI'd command function ({ dcmjs, positionals, values, stdout,
// stderr } -> exit code) with captured sinks. The commands were designed
// for injection from day one — this is the whole adapter between the CLI
// surface and MCP tool handlers.

export async function runCaptured(
  runFn,
  { dcmjs, positionals = [], values = {} }
) {
  const stdoutLines = [];
  const stderrLines = [];
  const code = await runFn({
    dcmjs,
    positionals,
    values,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
  });
  return { code, stdoutLines, stderrLines };
}

/**
 * Command failed: surface its stderr — the commands already write
 * corrective, parameter-naming messages there — as the tool error.
 */
export function commandError(name, { stderrLines }) {
  const detail = stderrLines.filter(Boolean).join("\n").trim();
  return new Error(detail || `${name} failed with no error output`);
}
