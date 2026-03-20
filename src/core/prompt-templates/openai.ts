export const OPENAI_SYSTEM_APPENDIX = `## Provider Guidance: OpenAI / Codex
- Prefer function-style tool usage and deterministic argument shapes
- Be strict about tool argument validity; malformed arguments waste turns
- For Codex-style execution, treat shell and file operations as first-class actions rather than narration
- Keep intermediate planning short and convert quickly into concrete tool calls
- When a tool round fails, adapt the plan before retrying instead of repeating the same call`;
