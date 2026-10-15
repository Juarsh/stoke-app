// Tester's separator cases + release rules after the e672dbe run (mirrors the Go tests).
import cases from './separator-cases.json';
import { parser } from '../src/parser';

type Case = { id: string; input: string; expect: string; rule: string; known_dish: string; known_text: string };

describe('separator cases', () => {
  test.each((cases as { cases: Case[] }).cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const r = parser.parse(c.input);
    const known = r.items.filter((it) => it.dish_id === c.known_dish);
    expect(known.length).toBeGreaterThan(0);
    const confirmed = known.some((it) => (it.source === 'table' && !it.needs_confirmation) || parser.claim(it) !== null);
    expect(confirmed).toBe(c.expect === 'confirmed');
    if (c.expect === 'unconfirmed') expect(known.some((it) => (it.flags ?? []).includes('leftover_nearby'))).toBe(true); // the right reason
  });
});

describe('release rules', () => {
  const flagged = (s: string, f: string) => parser.parse(s).items.some((it) => (it.flags ?? []).includes(f) && it.needs_confirmation);
  test.each(['half plate chole bhature', 'aadha plate chole bhature', '1/2 plate chole bhature', 'dedh plate chole bhature'])('fractional combo %s', (s) =>
    expect(flagged(s, 'fractional_combo')).toBe(true));
  test('half plate halves each part', () => {
    const r = parser.parse('half plate chole bhature');
    expect(r.items.map((it) => it.quantity)).toEqual([0.5, 1]);
    expect(r.items[0].span_start).not.toEqual(r.items[1].span_start);
  });
  test.each(['kuttu cheela', 'roti zorbo', 'zorbo roti', 'ragi roti', 'makki roti'])('leftover_nearby %s', (s) => expect(flagged(s, 'leftover_nearby')).toBe(true));
  test.each(['egg curry 3 eggs', '3 ande ki curry', '3 anda curry', '4 egg curry'])('egg count %s', (s) => {
    const r = parser.parse(s);
    expect(r.items.map((it) => it.dish_id).sort()).toEqual(['boiled_egg', 'egg_curry']);
    expect(r.items.every((it) => (it.flags ?? []).includes('egg_count') && it.needs_confirmation)).toBe(true);
  });
  test('2 roti aur 1 plate <unknown>: roti is claimed', () => {
    const roti = parser.parse('2 roti aur 1 plate zorbali').items.find((it) => it.dish_id === 'roti')!;
    expect(parser.claim(roti)).not.toBeNull();
  });
});
