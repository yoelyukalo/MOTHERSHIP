/**
 * MOTHERSHIP — Quantum Mirror taxonomy (v3)
 *
 * 21 entry types organised into 5 layers. Used by:
 *   - database.js CHECK constraints and auto-derivation of `layer`
 *   - quantum-mirror.js + synthesis prompt
 *   - retriever.js / obsidian exporter / telegram /mirror formatter
 */

const LAYERS = ['identity', 'pattern', 'direction', 'world', 'resilience'];

const STATUSES = ['active', 'resolved', 'evolved', 'archived'];

const ENTRY_TYPES_BY_LAYER = {
  identity:   ['belief', 'identity', 'state', 'fear'],
  pattern:    ['loop', 'trigger', 'signal', 'contradiction'],
  direction:  ['goal', 'commitment', 'decision', 'simulation', 'question', 'experiment'],
  world:      ['context', 'relationship', 'resource', 'influence', 'model'],
  resilience: ['constraint', 'win']
};

const ENTRY_TYPE_DESCRIPTIONS = {
  belief:        'core values, operating principles, truths held',
  identity:      'roles inhabited, who you\'re becoming',
  state:         'current emotional, physical, operational mode',
  fear:          'emotional undercurrents that silently distort decisions',
  loop:          'repeating behaviors, avoidance patterns',
  trigger:       'external conditions that activate behaviors',
  signal:        'communication patterns, how you show up',
  contradiction: 'active tensions between beliefs or wants',
  goal:          'directional outcomes being built toward',
  commitment:    'specific promises with deadlines',
  decision:      'choices made with rationale',
  simulation:    'projected outcomes on current trajectory',
  question:      'open unknowns being actively held',
  experiment:    'active tests with hypothesis and expected outcome',
  context:       'life situation, business status, circumstances',
  relationship:  'key people, dynamics, shifts',
  resource:      'energy, money, time, attention, capacity',
  influence:     'content consumed and how it shifted thinking',
  model:         'mental frameworks used to evaluate problems',
  constraint:    'hard boundaries and fixed limits',
  win:           'victories, breakthroughs, evidence of success'
};

const ENTRY_TYPES = Object.values(ENTRY_TYPES_BY_LAYER).flat();

const ENTRY_TYPE_TO_LAYER = {};
for (const [layer, types] of Object.entries(ENTRY_TYPES_BY_LAYER)) {
  for (const t of types) ENTRY_TYPE_TO_LAYER[t] = layer;
}

/**
 * Maps legacy v2 category strings to the closest v3 entry_type.
 * Used by the one-shot migration and by addMirrorEntry's back-compat path.
 */
const LEGACY_CATEGORY_MAP = {
  // v2 (dynamic rows) — the 8 categories from the Apr-13 plan
  mental_models:   'model',
  preferences:     'signal',
  knowledge_levels:'model',
  active_projects: 'context',
  decisions:       'decision',
  patterns:        'loop',
  contradictions:  'contradiction',
  goals:           'goal',
  // v1 (static JSON) remnants, just in case
  mental_model:    'model',
  learning_style:  'signal',
  knowledge_graph: 'model',
  resonance_log:   'signal'
};

function layerOf(entryType) {
  const layer = ENTRY_TYPE_TO_LAYER[entryType];
  if (!layer) throw new Error(`mirror-taxonomy: unknown entry_type '${entryType}'`);
  return layer;
}

function isValidEntryType(entryType) {
  return Object.prototype.hasOwnProperty.call(ENTRY_TYPE_TO_LAYER, entryType);
}

function isValidLayer(layer) {
  return LAYERS.includes(layer);
}

function isValidStatus(status) {
  return STATUSES.includes(status);
}

/**
 * Resolve any incoming category/entry_type label to a valid v3 entry_type.
 * Returns { entryType, layer, remapped } where `remapped` is true iff the
 * input didn't match the new vocabulary and we had to translate it.
 *
 * Unknown values fall back to 'context' (world layer) — the most generic
 * bucket for "stuff we know about Yoel's situation".
 */
function resolveEntryType(raw) {
  if (!raw) return { entryType: 'context', layer: 'world', remapped: true };
  if (isValidEntryType(raw)) return { entryType: raw, layer: layerOf(raw), remapped: false };
  const mapped = LEGACY_CATEGORY_MAP[raw];
  if (mapped) return { entryType: mapped, layer: layerOf(mapped), remapped: true };
  return { entryType: 'context', layer: 'world', remapped: true };
}

module.exports = {
  LAYERS,
  STATUSES,
  ENTRY_TYPES,
  ENTRY_TYPES_BY_LAYER,
  ENTRY_TYPE_TO_LAYER,
  ENTRY_TYPE_DESCRIPTIONS,
  LEGACY_CATEGORY_MAP,
  layerOf,
  isValidEntryType,
  isValidLayer,
  isValidStatus,
  resolveEntryType
};
