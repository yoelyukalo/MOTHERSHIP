/**
 * MOTHERSHIP — Quantum Mirror
 *
 * The cognitive profile engine. Stores and serves:
 * - mental_models: frameworks, heuristics, decision patterns
 * - learning_style: how Yoel absorbs and processes info
 * - knowledge_graph: topics, connections, expertise levels
 * - resonance_log: what clicks, what doesn't, patterns of engagement
 */

const db = require('./database');
const { v4: uuidv4 } = require('uuid');

// Default seed data for the Quantum Mirror
const DEFAULT_MIRROR = {
  mental_models: [
    { id: 'mm-1', name: 'First Principles', description: 'Break problems down to fundamental truths, then rebuild from there.', strength: 0.9, tags: ['reasoning', 'strategy'] },
    { id: 'mm-2', name: 'Systems Thinking', description: 'See interconnections and feedback loops, not isolated events.', strength: 0.8, tags: ['reasoning', 'complexity'] },
    { id: 'mm-3', name: 'Build in Public', description: 'Ship fast, iterate with real feedback, compound visibility.', strength: 0.85, tags: ['execution', 'growth'] },
  ],
  learning_style: {
    primary: 'visual-kinesthetic',
    preferences: [
      { mode: 'By building', score: 0.95, note: 'Learns fastest by creating working prototypes' },
      { mode: 'Through conversation', score: 0.85, note: 'Processes ideas by talking them through' },
      { mode: 'From examples', score: 0.80, note: 'Concrete examples over abstract theory' },
      { mode: 'Pattern matching', score: 0.75, note: 'Spots patterns across domains quickly' },
    ],
    avoid: ['Long lectures', 'Dense academic papers without examples', 'Step-by-step tutorials without context']
  },
  knowledge_graph: [
    { id: 'kg-1', topic: 'AI / LLMs', level: 'advanced', connections: ['business', 'automation', 'product'], notes: 'Deep practical knowledge, building with Claude/GPT' },
    { id: 'kg-2', topic: 'Business Strategy', level: 'advanced', connections: ['AI / LLMs', 'product', 'marketing'], notes: 'Multiple ventures, pattern recognition across industries' },
    { id: 'kg-3', topic: 'Product Development', level: 'advanced', connections: ['AI / LLMs', 'business', 'code'], notes: 'End-to-end from idea to shipped product' },
    { id: 'kg-4', topic: 'JavaScript / Node.js', level: 'intermediate', connections: ['code', 'automation'], notes: 'Building Mothership, learning by doing' },
    { id: 'kg-5', topic: 'Marketing / GTM', level: 'intermediate', connections: ['business', 'product'], notes: 'Go-to-market strategies, audience building' },
    { id: 'kg-6', topic: 'visionOS / Spatial', level: 'exploring', connections: ['product', 'AI / LLMs'], notes: 'Future frontier, early research' },
  ],
  resonance_log: []
};

function getMirror() {
  const stored = db.getConfig('quantum_mirror', null);
  if (stored) {
    try { return JSON.parse(stored); } catch (e) {}
  }
  // Seed with defaults on first access
  saveMirror(DEFAULT_MIRROR);
  return DEFAULT_MIRROR;
}

function saveMirror(mirror) {
  db.setConfig('quantum_mirror', JSON.stringify(mirror));
}

// --- Mental Models ---

function getModels() {
  return getMirror().mental_models;
}

function addModel(name, description, strength = 0.5, tags = []) {
  const mirror = getMirror();
  const model = { id: `mm-${uuidv4().slice(0, 8)}`, name, description, strength, tags };
  mirror.mental_models.push(model);
  saveMirror(mirror);
  db.log('info', 'mirror', `Mental model added: ${name}`);
  return model;
}

function updateModel(id, updates) {
  const mirror = getMirror();
  const idx = mirror.mental_models.findIndex(m => m.id === id);
  if (idx === -1) return null;
  mirror.mental_models[idx] = { ...mirror.mental_models[idx], ...updates };
  saveMirror(mirror);
  return mirror.mental_models[idx];
}

function removeModel(id) {
  const mirror = getMirror();
  mirror.mental_models = mirror.mental_models.filter(m => m.id !== id);
  saveMirror(mirror);
}

// --- Learning Style ---

function getLearningStyle() {
  return getMirror().learning_style;
}

function updateLearningStyle(updates) {
  const mirror = getMirror();
  mirror.learning_style = { ...mirror.learning_style, ...updates };
  saveMirror(mirror);
  return mirror.learning_style;
}

// --- Knowledge Graph ---

function getKnowledgeGraph() {
  return getMirror().knowledge_graph;
}

function addKnowledge(topic, level, connections = [], notes = '') {
  const mirror = getMirror();
  const node = { id: `kg-${uuidv4().slice(0, 8)}`, topic, level, connections, notes };
  mirror.knowledge_graph.push(node);
  saveMirror(mirror);
  db.log('info', 'mirror', `Knowledge node added: ${topic}`);
  return node;
}

function updateKnowledge(id, updates) {
  const mirror = getMirror();
  const idx = mirror.knowledge_graph.findIndex(k => k.id === id);
  if (idx === -1) return null;
  mirror.knowledge_graph[idx] = { ...mirror.knowledge_graph[idx], ...updates };
  saveMirror(mirror);
  return mirror.knowledge_graph[idx];
}

function removeKnowledge(id) {
  const mirror = getMirror();
  mirror.knowledge_graph = mirror.knowledge_graph.filter(k => k.id !== id);
  saveMirror(mirror);
}

// --- Resonance Log ---

function getResonanceLog(limit = 50) {
  const mirror = getMirror();
  return mirror.resonance_log.slice(-limit);
}

function logResonance(type, content, score, tags = []) {
  const mirror = getMirror();
  const entry = {
    id: `rl-${uuidv4().slice(0, 8)}`,
    type, // 'insight', 'friction', 'breakthrough', 'pattern'
    content,
    score, // -1 to 1 (friction to resonance)
    tags,
    created_at: new Date().toISOString()
  };
  mirror.resonance_log.push(entry);
  // Keep last 500 entries
  if (mirror.resonance_log.length > 500) {
    mirror.resonance_log = mirror.resonance_log.slice(-500);
  }
  saveMirror(mirror);
  return entry;
}

module.exports = {
  getMirror, saveMirror,
  getModels, addModel, updateModel, removeModel,
  getLearningStyle, updateLearningStyle,
  getKnowledgeGraph, addKnowledge, updateKnowledge, removeKnowledge,
  getResonanceLog, logResonance
};
