export const ANTHROPIC_SYSTEM_APPENDIX = `## Provider Guidance: Anthropic / Claude
- Prefer Anthropic tool-use flow when tools are available
- Keep tool calls structured and minimal; batch only truly independent work
- Use concise natural language between tool turns, then resume execution
- If tool results conflict, resolve the conflict explicitly before the next tool call
- Use thinking blocks operationally when the runtime exposes them, but keep final visible output concise`;
