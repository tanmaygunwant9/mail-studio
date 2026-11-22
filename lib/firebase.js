export const firebaseConfig = {
  apiKey: 'AIzaSyBCxwI4Z6WlE2U0ykfh7y2TeX403S7HIQQ',
  authDomain: 'mail-studio-14fe0.firebaseapp.com',
  projectId: 'mail-studio-14fe0',
  appId: '1:396366888613:web:03d112c4ac7f8acb9b174c'
};

export async function verifyFirebaseUser(idToken) {
  if (typeof idToken !== 'string' || idToken.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(idToken)) return null;
  const url = new URL('https://identitytoolkit.googleapis.com/v1/accounts:lookup');
  url.searchParams.set('key', firebaseConfig.apiKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 400 || response.status === 401) return null;
  if (!response.ok) throw new Error('Firebase Authentication is unavailable. Try again shortly.');
  const { users } = await response.json();
  const user = users?.[0];
  const google = user?.providerUserInfo?.find(provider => provider.providerId === 'google.com');
  if (!user?.localId || user.disabled || user.emailVerified !== true || !google?.federatedId) return null;

  // Firebase accepted this token. Check its project and sign-in method before creating a session.
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url'));
  if (claims.aud !== firebaseConfig.projectId || claims.iss !== `https://securetoken.google.com/${firebaseConfig.projectId}` ||
      claims.sub !== user.localId || claims.firebase?.sign_in_provider !== 'google.com') return null;
  return { uid: user.localId, googleSubject: google.federatedId, email: user.email };
}
