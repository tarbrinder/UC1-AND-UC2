// ─── Source Distillation (P5 · WA/PNS/CSL → THEMES, not counts) ───────────────
// "WhatsApp 660 · CSL 100" tells a seller nothing. The buyer's behaviour across channels (PNS calls,
// WhatsApp, CSL browse, BL history) is already clustered by the Twin into intents + categories — this
// FUSES those into a few human THEMES: "Industrial Chemicals · Cleaning Supplies · Automotive Care".
//
// Pure · NO new LLM call · NO category hardcoding — it ranks only the strings the Twin already produced
// from real signals. The earlier inline version read recent_intent_clusters ALONE; this fuses all three
// channels so themes still surface when one is sparse, and de-dups across them (case-insensitive).

export interface DistillInput {
  recentClusters?: Array<{ intent?: string; signal_count?: number; last_seen?: string }>;
  historicalCategories?: string[];
  intentHistory?: Record<string, number>; // baseline distribution: intent → count
}
export interface DistilledThemes {
  themes: string[];     // top human themes, de-duped, weight-ranked
  line: string;         // themes joined " · " (dossier-ready)
  sourceCount: number;  // raw signals folded in (for "distilled from N signals")
}

const tslug = (s?: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function distillSourceThemes(input: DistillInput, max = 3): DistilledThemes {
  const weights = new Map<string, { label: string; weight: number }>();
  const add = (raw: string | undefined, weight: number) => {
    const label = (raw || '').trim();
    const key = tslug(label);
    if (!key) return;
    const cur = weights.get(key);
    if (cur) cur.weight += weight;        // same theme across channels → weights compound, label kept
    else weights.set(key, { label, weight });
  };
  let sourceCount = 0;
  // Recent intent clusters = strongest + most recent → weight by signal volume.
  for (const c of input.recentClusters || []) {
    const sc = Math.max(1, c.signal_count || 1);
    add(c.intent, 3 * sc);
    sourceCount += sc;
  }
  // Baseline intent distribution.
  for (const [intent, count] of Object.entries(input.intentHistory || {})) {
    const c = Math.max(1, Number(count) || 1);
    add(intent, c);
    sourceCount += c;
  }
  // Historical categories — presence signal (the cluster labels may omit a category enrichment has).
  for (const cat of input.historicalCategories || []) add(cat, 2);

  const ranked = [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, max)).map((x) => x.label);
  return { themes: ranked, line: ranked.join(' · '), sourceCount };
}
