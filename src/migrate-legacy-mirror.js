/**
 * MOTHERSHIP — One-time migration of legacy JSON mirror to mirror_entries rows.
 *
 * Runs on every boot; no-op if already done. Guarded by a config flag.
 */

const db = require('./database');
const ve = require('./memory/vector-engine');

const FLAG = 'mirror_migrated_to_rows';

async function runIfNeeded({ userId } = {}) {
  if (!userId) throw new Error('migrate-legacy-mirror: userId required');
  if (db.getConfig(FLAG) === '1') return 0;

  const raw = db.getConfig('quantum_mirror');
  if (!raw) {
    db.setConfig(FLAG, '1');
    return 0;
  }

  let legacy;
  try { legacy = JSON.parse(raw); }
  catch {
    db.log('warn', 'migrate-mirror', 'legacy JSON unparsable — skipping');
    db.setConfig(FLAG, '1');
    return 0;
  }

  let count = 0;

  for (const m of legacy.mental_models || []) {
    await ve.storeMirrorEntry({
      entry_type: 'model',
      content: `${m.name}: ${m.description}`,
      confidence: m.strength ?? 0.7,
      source_type: 'migration',
      source_id: `legacy:${m.id || m.name}`,
      userId
    });
    count++;
  }

  if (legacy.learning_style) {
    const ls = legacy.learning_style;
    await ve.storeMirrorEntry({
      entry_type: 'signal',
      content: `Learning style is primarily ${ls.primary}.`,
      confidence: 0.7,
      source_type: 'migration',
      source_id: 'legacy:learning_style',
      userId
    });
    count++;

    for (const pref of ls.preferences || []) {
      await ve.storeMirrorEntry({
        entry_type: 'signal',
        content: `Prefers to learn ${pref.mode.toLowerCase()} — ${pref.note}`,
        confidence: pref.score ?? 0.7,
        source_type: 'migration',
        source_id: `legacy:pref:${pref.mode}`,
        userId
      });
      count++;
    }

    for (const avoid of ls.avoid || []) {
      await ve.storeMirrorEntry({
        entry_type: 'signal',
        content: `Dislikes: ${avoid}`,
        confidence: 0.6,
        source_type: 'migration',
        source_id: `legacy:avoid:${avoid}`,
        userId
      });
      count++;
    }
  }

  for (const k of legacy.knowledge_graph || []) {
    await ve.storeMirrorEntry({
      entry_type: 'model',
      content: `${k.topic} — ${k.level}. ${k.notes || ''}`.trim(),
      confidence: 0.75,
      source_type: 'migration',
      source_id: `legacy:kg:${k.id || k.topic}`,
      userId
    });
    count++;
  }

  db.setConfig(FLAG, '1');
  db.log('info', 'migrate-mirror', `migrated ${count} legacy entries to mirror_entries`);
  return count;
}

module.exports = { runIfNeeded };
