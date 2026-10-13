/** Check the adapter example, not a general-purpose YAML parser. */
export function hasConfiguredCorsOrigins(template, expected) {
  // The generator emits a double-quoted list at these fixed indent levels.
  // Missing, duplicate or unknown-format sections fail rather than guessing.
  const sections = [...template.matchAll(/^        AllowOrigins:\n((?:          - [^\n]*\n)+)/gm)];
  if (sections.length !== 1 || !Array.isArray(expected) || expected.length === 0) return false;
  try {
    const actual = sections[0][1].trimEnd().split('\n').map(line => {
      const match = /^          - ("(?:[^"\\]|\\.)*")$/.exec(line);
      if (!match) throw new Error('Unknown generated origin format');
      return JSON.parse(match[1]);
    });
    return actual.length === expected.length && actual.every((origin, index) => origin === expected[index]);
  } catch {
    return false;
  }
}
