import { describe, expect, it } from 'vitest';
import { simulate } from './ball.ts';
import { DEBUG_THROWS } from './debugThrows.ts';

describe('debug throws', () => {
  it('"Drop ball" falls 30 cm onto the player\'s half', () => {
    const run = simulate(DEBUG_THROWS.drop(), { maxTime: 1, until: (_s, _t, events) => events.length > 0 });
    expect(run.events[0]!.event).toMatchObject({ type: 'bounce', half: 'player' });
  });

  it('"Throw into net" ends dead', () => {
    expect(simulate(DEBUG_THROWS.intoNet(), { maxTime: 2 }).state.status).toBe('dead');
  });

  it('"Throw off table" ends out, off the table', () => {
    const run = simulate(DEBUG_THROWS.offTable(), { maxTime: 2 });
    expect(run.state.status).toBe('out');
    expect(run.events.map((e) => e.event)).toContainEqual(expect.objectContaining({ type: 'out', reason: 'off-table' }));
  });
});
