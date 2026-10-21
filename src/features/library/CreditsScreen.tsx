import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Button, Card, Screen, T } from '@/components/ui';
import { exercises } from '@/lib/exercises';
import { allAuthors, licenceCounts } from './model';

const open = (url: string) => { void Linking.openURL(url).catch(() => {}); };
const NAMES: Record<string, string> = { 'CC-BY-SA-4.0': 'CC BY-SA 4.0', 'CC-BY-SA-3.0': 'CC BY-SA 3.0', 'CC0-1.0': 'CC0' };

/** Settings › Credits & licences (§9.6). Only what this build ships: wger text and our exercise table. */
export function CreditsScreen() {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const authors = allAuthors(exercises);
  const counts = Object.entries(licenceCounts(exercises)).map(([l, n]) => `${NAMES[l] ?? l}: ${n}`).join(' · ');
  return (
    <Screen title="Credits & licences" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      <Card>
        <T v="bodyStrong">wger.de contributors</T>
        <T tone="text2">Exercise names, steps and muscles are adapted from wger.de, under CC BY-SA 4.0 and 3.0 (a few rows are CC0).</T>
        <T v="caption" tone="muted">{exercises.all().length} exercises · {counts}</T>
        <T v="bodyStrong" tone="em" accessibilityRole="link" accessibilityLabel="wger.de. Opens the website" onPress={() => open('https://wger.de/')} style={{ paddingVertical: 12 }}>wger.de ↗</T>
        <T v="bodyStrong" tone="em" accessibilityRole="button" accessibilityLabel={all ? 'Hide authors' : `All authors, ${authors.length}`} onPress={() => setAll(!all)} style={{ paddingVertical: 12 }}>
          {all ? 'Hide authors ‹' : 'All authors ›'}
        </T>
        {all ? <T v="caption" tone="text2">{authors.join(', ')}</T> : null}
      </Card>
      <Card>
        <T v="bodyStrong">Our exercise table</T>
        <T tone="text2">Our curated table is under CC BY-SA 4.0, as the ShareAlike terms require. Each row keeps its wger id, licence and authors.</T>
      </Card>
    </Screen>
  );
}
