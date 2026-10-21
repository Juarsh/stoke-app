// M4: Google sign-in is wired behind the googleSignIn flag (EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1) with the client ids from env
// (EXPO_PUBLIC_GOOGLE_{ANDROID,WEB,IOS}_CLIENT_ID). Off by default: the build keeps the mock sign-in. On: the Google ID
// token is the user's bearer token (the server verifies it against GOOGLE_CLIENT_IDS).
import React from 'react';
import { act, create } from 'react-test-renderer';

const mockCfg = { flag: false };
const mockPrompt = jest.fn();
let mockRes: unknown = null;
jest.mock('../src/lib/config', () => ({
  config: { apiUrl: '', mock: true, mockAi: false, mockAiDelay: 0, google: { android: 'and.apps.googleusercontent.com', web: 'web.apps.googleusercontent.com', ios: '' } },
  get flags() { return { steps: true, community: true, healthConnect: false, googleSignIn: mockCfg.flag }; },
  brand: { name: 'Stoke', slug: 'placeholder-fit', scheme: 'stoke', androidPackage: 'app.stokefit', iosBundleId: 'app.stokefit', inviteBaseUrl: '' },
}));
const mockReqArgs: unknown[] = [];
jest.mock('expo-auth-session/providers/google', () => ({ useIdTokenAuthRequest: (a: unknown) => { mockReqArgs.push(a); return [{}, mockRes, mockPrompt]; } }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: () => {} }));
const mockSignIn = jest.fn();
jest.mock('../src/lib/store', () => ({ useStore: () => ({ signIn: mockSignIn }) }));
jest.mock('@/components/ui', () => {
  const { Text, View } = jest.requireActual('react-native');
  return { Screen: ({ children }: { children: React.ReactNode }) => <View>{children}</View>, Card: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    T: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text>, Button: ({ title, onPress }: { title: string; onPress: () => void }) => <Text onPress={onPress}>{title}</Text> };
});

import SignIn from '../src/app/sign-in';

const texts = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string');

test('off by default: the mock sign-in, no Google request', async () => {
  mockCfg.flag = false; mockReqArgs.length = 0;
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SignIn />); });
  expect(texts(r)).toContain('Continue with Google (mock)');
  expect(mockReqArgs).toEqual([]);
});

test('on: the env client ids go to Google, and its ID token signs the user in', async () => {
  mockCfg.flag = true; mockReqArgs.length = 0;
  const payload = Buffer.from(JSON.stringify({ sub: '1098', name: 'Akarsh', email: 'a@x.in' })).toString('base64url');
  mockRes = { type: 'success', params: { id_token: `h.${payload}.s` } };
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SignIn />); });
  expect(texts(r)).toContain('Continue with Google');
  expect(mockReqArgs[0]).toEqual({ androidClientId: 'and.apps.googleusercontent.com', webClientId: 'web.apps.googleusercontent.com', iosClientId: undefined });
  expect(mockSignIn).toHaveBeenCalledWith({ id: '1098', name: 'Akarsh', email: 'a@x.in', idToken: `h.${payload}.s`, mock: false });
});
