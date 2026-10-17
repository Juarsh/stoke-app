// Designer (Oct 17): the Add next to a kcal field uses the primary button tokens at 44 px (coral fill, dark text) so it
// meets 3:1 on the card; disabled = 40% opacity until a valid number is typed.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, TextInput } from 'react-native';
import { KcalRow } from '../src/components/KcalRow';
import { FailedAiRow } from '../src/components/LogRows';
import { palette } from '../src/theme/tokens';

const btn = (r: ReactTestRenderer, name: string) => r.root.findAll((n) => n.props.accessibilityLabel === `Add ${name}` && typeof n.props.onPress === 'function')[0];
const look = (r: ReactTestRenderer, name: string) => {
  const b = r.root.findAll((n) => n.props.accessibilityLabel === `Add ${name}` && typeof n.type === 'string')[0]; const st = b.props.style;
  return StyleSheet.flatten(st) as { backgroundColor: string; opacity?: number; height: number; borderWidth?: number };
};

test('Review Enter kcal: coral 44 px Add, 40% until a valid number, then full and tappable', async () => {
  const onAdd = jest.fn();
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<KcalRow name="kombucha" onAdd={onAdd} onRemove={() => {}} />); });
  let s = look(r, 'kombucha');
  expect(s.backgroundColor).toBe(palette.light.accentFill); expect(s.height).toBe(44); expect(s.opacity).toBe(0.4);
  expect(btn(r, 'kombucha').props.disabled).toBe(true);
  const input = r.root.findAllByType(TextInput)[0];
  await act(async () => { input.props.onChangeText('0'); });
  expect(look(r, 'kombucha').opacity).toBe(0.4);
  await act(async () => { input.props.onChangeText('120'); });
  s = look(r, 'kombucha');
  expect(s.opacity).toBeUndefined(); expect(s.backgroundColor).toBe(palette.light.accentFill);
  await act(async () => { btn(r, 'kombucha').props.onPress(); });
  expect(onAdd).toHaveBeenCalledWith(120);
  const label = r.root.findAll((n) => n.props.children === 'Add' && n.props.style)[0];
  expect(StyleSheet.flatten(label.props.style).color).toBe(palette.light.onGrad);
});

test('failed AI row: same coral Add; disabled (40%) until kcal > 0, as before', async () => {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<FailedAiRow row={{ name: 'zanthu', kcal: '', added: false, reason: 'daily_limit' }} onKcal={() => {}} onAdd={() => {}} />); });
  expect(look(r, 'zanthu')).toMatchObject({ backgroundColor: palette.light.accentFill, height: 44, opacity: 0.4 });
  await act(async () => { r.update(<FailedAiRow row={{ name: 'zanthu', kcal: '90', added: false, reason: 'daily_limit' }} onKcal={() => {}} onAdd={() => {}} />); });
  expect(look(r, 'zanthu').opacity).toBeUndefined();
  expect(btn(r, 'zanthu').props.disabled).toBe(false);
});
