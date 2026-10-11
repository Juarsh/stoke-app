import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Share } from 'react-native';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { brand, flags } from '@/lib/config';
import { addDays, localDate } from '@/lib/domain';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';

export default function Community() {
  const st = useStore(); const d = useDay(); const router = useRouter();
  if (!flags.community) return <Screen title="Community"><T tone="muted">Coming soon.</T></Screen>;
  const ch = st.challenge;
  const daysIn = ch ? Math.min(21, Math.max(1, Math.round((Date.parse(localDate()) - Date.parse(ch.startDate)) / 86400000) + 1)) : 0;
  const myDays = ch ? [...d.loggedDates].filter((x) => x >= ch.startDate && x <= addDays(ch.startDate, 20)).length : 0;
  const link = ch ? `${brand.inviteBaseUrl}?c=${ch.code}` : '';
  const board = ch ? [...ch.members.filter((m) => m.name !== 'You'), { name: 'You', days: myDays }].sort((a, b) => b.days - a.days) : [];
  return (
    <Screen title="Community">
      {!ch ? (
        <Card>
          <T v="headline">21-day challenge</T>
          <T tone="text2">Log on 21 days with friends. Ranked by days logged only, never calories or weight.</T>
          <Button title="+ New challenge" onPress={() => st.setChallenge({ code: st.newId().slice(0, 6).toUpperCase(), title: '21-day challenge', startDate: localDate(), members: [] })} />
          <Button kind="soft" title="Open an invite link" onPress={() => Linking.openURL(Linking.createURL('/community'))} />
        </Card>
      ) : (
        <>
          <Card tone="primarySoft"><T v="bodyStrong" tone="primaryText">Day {daysIn} of 21 · ends {addDays(ch.startDate, 20)}</T><T tone="primaryText">You’ve logged {myDays} days.</T></Card>
          <Card>
            <T v="bodyStrong">Leaderboard · days logged</T>
            {board.map((m, i) => <Row key={m.name} style={{ justifyContent: 'space-between' }}><T tone={i < 3 ? 'accent' : 'text'}>{i + 1}. {m.name}</T><T>{m.days} / {daysIn}</T></Row>)}
            <T v="caption" tone="muted">Only days logged are shown. Members appear once the server is connected.</T>
          </Card>
          <Card><T v="caption" tone="muted">Invite link (opens the app, or the Play Store):</T><T selectable>{link}</T></Card>
          <Button title="Invite on WhatsApp" onPress={() => Share.share({ message: `Join my 21-day ${brand.name} challenge: ${link}` })} />
          <Button kind="soft" title="Share my streak card" onPress={() => router.push('/share')} />
          <Button kind="ghost" title="Leave challenge" onPress={() => st.setChallenge(null)} />
        </>
      )}
    </Screen>
  );
}
