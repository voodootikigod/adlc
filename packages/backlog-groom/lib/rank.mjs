/**
 * Ranking (spec §3.5).
 *
 * Computed from what grooming LEARNED — the verdict, the cluster size, whether
 * the issue's paths are frozen — with the existing priority label as ONE INPUT
 * AMONG SEVERAL, never the answer. The decay of those labels is the reason this
 * package exists, so reading them as ground truth would inherit exactly the
 * staleness it is meant to correct.
 *
 * The weights are deliberately visible in the returned `inputs`, so a rank can
 * be argued with rather than merely obeyed — the relabel proposal it triggers
 * (§3.4a) has to show a reviewer its reasoning.
 */

/** Which priority band a label denotes, per the profile's mapping. */
export function bandOfLabel(labels, priorityMap) {
  for (const [band, label] of Object.entries(priorityMap ?? {})) {
    if ((labels ?? []).includes(label)) return band;
  }
  return null;
}

const VERDICT_WEIGHT = {
  valid: 0.5, // still real: the strongest evidence that it matters
  moved: 0.3, // real, but needs re-locating before it can be worked
  unverified: 0.25, // we have not looked; neither promote nor bury
  unverifiable: 0.15,
  fixed: 0, // nothing left to do
};

const LABEL_WEIGHT = { high: 0.3, medium: 0.18, low: 0.05 };

/** Bands, highest first — exported so callers compare rather than re-derive. */
export const BANDS = Object.freeze(['high', 'medium', 'low']);

/**
 * Score an issue in [0,1] and map it to a band.
 *
 * @returns {{score:number, band:string, inputs:object, labelBand:string|null}}
 */
export function rankIssue({ verdict, labels = [], priorityMap, clusterSize = 1, frozen = false }) {
  const labelBand = bandOfLabel(labels, priorityMap);
  const inputs = {
    verdict: VERDICT_WEIGHT[verdict] ?? 0.15,
    // A bigger cluster means more issues share one surface, so fixing one is
    // worth more — capped, so cluster size can never outweigh the verdict.
    cluster: Math.min(0.2, Math.max(0, clusterSize - 1) * 0.05),
    // An unlabelled issue sits between medium and low rather than at zero: the
    // absence of a label is not evidence of unimportance.
    label: labelBand ? LABEL_WEIGHT[labelBand] : 0.1,
    // Frozen paths cannot be actioned now, so they rank lower whatever else says.
    frozen: frozen ? -0.25 : 0,
  };
  const raw = inputs.verdict + inputs.cluster + inputs.label + inputs.frozen;
  const score = Math.max(0, Math.min(1, raw));
  const band = score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : 'low';
  return { score: Number(score.toFixed(4)), band, inputs, labelBand };
}
