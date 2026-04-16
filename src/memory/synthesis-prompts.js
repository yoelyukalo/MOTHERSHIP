/**
 * MOTHERSHIP — Synthesis prompt templates
 *
 * All Claude-directed synthesis prompts live here so Phase 5 (self-improvement)
 * can version and A/B them.
 */

const {
  ENTRY_TYPES_BY_LAYER, ENTRY_TYPE_DESCRIPTIONS
} = require('../mirror-taxonomy');

const TAXONOMY_BLOCK = Object.entries(ENTRY_TYPES_BY_LAYER)
  .map(([layer, types]) => {
    const lines = types.map(t => `  - ${t} — ${ENTRY_TYPE_DESCRIPTIONS[t]}`).join('\n');
    return `${layer.toUpperCase()} LAYER:\n${lines}`;
  })
  .join('\n\n');

const MIRROR_SYNTHESIS = ({ existing, turn }) => `
You are helping Mothership build and maintain its cognitive profile of Yoel.

The profile uses a 21-type taxonomy organised into 5 layers:

${TAXONOMY_BLOCK}

Here are the currently-active mirror entries that might be relevant to the
interaction below. Each has an entry_type, content, confidence, and ID:

${existing.length ? existing.map(e => `- [${e.id}] (${e.entry_type}, conf=${e.confidence}) ${e.content}`).join('\n') : '(none)'}

Here is the latest interaction (Yoel → Mothership):

${turn}

Based ONLY on this interaction, decide whether any of the following should
happen, and output STRICT JSON matching this schema:

{
  "new_entries": [{"entry_type": string, "content": string, "confidence": number}],
  "supersede": [{"old_id": string, "new_content": string, "new_confidence": number}],
  "contradictions": [{"entry_id": string, "note": string}]
}

Rules:
- entry_type MUST be one of the 21 values listed above.
- If the interaction reveals nothing meaningful about Yoel, return empty arrays.
- Confidence is 0.0-1.0; use <=0.5 for soft hints, >=0.8 for clear statements.
- Only supersede an existing entry if the new observation genuinely refines or contradicts it.
- Content should be a single declarative sentence about Yoel, not about the conversation.
- Pick the most specific entry_type that fits; avoid defaulting to 'context' or 'belief' when a narrower type applies.

Output ONLY the JSON object, no prose.`;

const WIKI_SYNTHESIS = ({ existingTopics, mirrorSnapshot, content }) => `
You are helping Mothership synthesize knowledge from content Yoel has ingested.

Yoel's profile (used to prioritize what matters):
${mirrorSnapshot}

Existing wiki topics (reuse these before creating new ones):
${existingTopics.length ? existingTopics.map(t => `- ${t}`).join('\n') : '(none yet)'}

New content to process:
${content}

Output STRICT JSON:

{
  "topics": [
    {
      "topic": string,
      "mode": "create" | "merge",
      "summary": string,
      "tags": string[]
    }
  ]
}

Rules:
- Prefer merging into existing topics over creating new ones.
- Frame summaries through the lens of Yoel's profile — highlight what matters to him.
- 1-5 topics max per call.
- Output ONLY the JSON object.`;

const HEALTH_CONTRADICTIONS = ({ entries }) => `
Review the following mirror entries for contradictions, staleness, or merge
candidates. Output STRICT JSON:

{
  "contradictions": [{"entry_ids": string[], "note": string}],
  "merge_candidates": [{"entry_ids": string[], "suggested_content": string}]
}

Entries:
${entries.map(e => `- [${e.id}] (${e.entry_type}/${e.layer}, conf=${e.confidence}, ${e.updated_at}) ${e.content}`).join('\n')}

Output ONLY the JSON object.`;

const GAP_ANALYSIS = ({ mirror, wikiTopics }) => `
Based on Yoel's profile and current wiki state, identify knowledge gaps and
under-populated regions of the 21-type mirror taxonomy.

Profile (grouped by layer → entry_type):
${mirror}

Wiki topics:
${wikiTopics.join(', ') || '(none)'}

Output STRICT JSON:

{
  "knowledge_gaps": [{"gap": string, "why_it_matters": string}],
  "thin_mirror_entry_types": [{"entry_type": string, "layer": string, "suggestion": string}]
}

Output ONLY the JSON object.`;

module.exports = { MIRROR_SYNTHESIS, WIKI_SYNTHESIS, HEALTH_CONTRADICTIONS, GAP_ANALYSIS };
