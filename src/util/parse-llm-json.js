/**
 * MOTHERSHIP — Shared JSON extractor for LLM responses
 *
 * Claude (and most chat models) intermittently wrap JSON output in a
 * ```json ... ``` fence, add a lead-in sentence, or emit trailing commentary
 * even when the prompt says "output ONLY the JSON object". Every synthesis/
 * extraction/reflection module had its own nearly-identical brittle parser.
 * This is the single implementation they all share.
 *
 * Returns the parsed object on success, or null on any failure.
 */

function parseLlmJson(text) {
  let trimmed = (text || '').trim();
  if (!trimmed) return null;

  // ```json ... ``` or ``` ... ``` wrapper — strip it before parsing.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) trimmed = fenceMatch[1].trim();

  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Greedy {..} extraction for responses that bury JSON in prose.
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { return null; }
  }
  return null;
}

module.exports = { parseLlmJson };
