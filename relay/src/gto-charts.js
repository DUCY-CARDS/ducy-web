// ducy's preflop GTO strategy, for the relay's check for real-time
// assistance (#591, assist.js): the same charts the site shows (charts/,
// from ducy-gto's sixmax_charts and hu_charts), bundled into the relay. Each
// is one depth's spots, every spot 169 hands × how often the model folds,
// calls, raises and goes all-in.
//
// The relay has no GTO engine of its own (its wasm is the clubs-only build,
// #463), so these charts are the model it scores against: preflop, Hold'em,
// six-handed or heads-up, at the depths they were solved for.

import index from '../../charts/index.json' with { type: 'json' };
import six5 from '../../charts/ducybot-5.json' with { type: 'json' };
import six10 from '../../charts/ducybot-10.json' with { type: 'json' };
import six15 from '../../charts/ducybot-15.json' with { type: 'json' };
import six25 from '../../charts/ducybot-25.json' with { type: 'json' };
import six50 from '../../charts/ducybot-50.json' with { type: 'json' };
import six100 from '../../charts/ducybot-100.json' with { type: 'json' };
import six200 from '../../charts/ducybot-200.json' with { type: 'json' };
import hu5 from '../../charts/ducybot-hu-5.json' with { type: 'json' };
import hu10 from '../../charts/ducybot-hu-10.json' with { type: 'json' };
import hu25 from '../../charts/ducybot-hu-25.json' with { type: 'json' };
import hu50 from '../../charts/ducybot-hu-50.json' with { type: 'json' };
import hu100 from '../../charts/ducybot-hu-100.json' with { type: 'json' };
import hu200 from '../../charts/ducybot-hu-200.json' with { type: 'json' };

// The chart files bundled; test/assist.test.mjs checks they're every one
// charts/index.json lists.
export const CHARTS = {sixmax: [six5, six10, six15, six25, six50, six100, six200], hu: [hu5, hu10, hu25, hu50, hu100, hu200]};
export const INDEX = index;

// The model from chart files: {sixmax, hu}, each a list of {bb, spots:
// Map(id → {id, kind, hero, villain, facing, sizes, cells})}, by depth.
// `cells`: 169 × [fold, call, raise, all-in] as shares that sum to 1;
// `sizes`: the raise sizes short of all-in, in big blinds (heads-up charts
// give them; six-handed ones don't, assist.js works them out).
export function chartModel(charts = CHARTS) {
  const table = files => files.map(f => ({
    bb: Number(f.bb),
    spots: new Map(f.spots.map(s => [s.id, {
      id: s.id, kind: s.kind, hero: s.hero, villain: s.villain ?? null,
      facing: s.facing ?? null, sizes: (s.sizes || []).map(x => Number(x.to)),
      cells: s.cells.map(c => {
        const sum = c.reduce((a, b) => a + b, 0) || 1;
        return c.map(x => x / sum);
      }),
    }])),
  })).sort((a, b) => a.bb - b.bb);
  return {sixmax: table(charts.sixmax), hu: table(charts.hu)};
}

let model = null;
// The bundled charts as a model, built once.
export const MODEL = () => (model ||= chartModel());
