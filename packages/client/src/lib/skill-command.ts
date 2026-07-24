export interface SkillInvocation {
  name: string;
  instructions?: string;
}

/**
 * Parse a skill slash command only when its name exactly matches an enabled
 * palette entry. This keeps `/skill:unknown` in normal slash-command error
 * handling rather than allowing an arbitrary SDK command through.
 */
export function parseSkillInvocation(
  text: string,
  availableSkillNames: ReadonlySet<string>,
): SkillInvocation | undefined {
  if (!text.startsWith("/skill:")) return undefined;
  const firstSpace = text.search(/\s/);
  const command = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const name = command.slice("/skill:".length);
  if (name.length === 0 || !availableSkillNames.has(name)) return undefined;

  const instructions = firstSpace === -1 ? undefined : text.slice(firstSpace).trim();
  return instructions === undefined || instructions.length === 0
    ? { name }
    : { name, instructions };
}
