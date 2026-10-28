// Customer sign-in/up through the Cognito hosted login (authorization code + PKCE,
// no client secret in the browser). Signing in is optional: guests can still order.
// config.json is written by Terraform: { auth: "cognito", domain, clientId, redirectUri }.
// In local dev it is { auth: "dev" } and "signing in" just asks for an email.
const KEY = "fisa-shop-session";
let config;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const decode = (jwt) => JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(KEY));
    return session && session.expires_at > Date.now() + 30_000 ? session : null;
  } catch {
    return null;
  }
}

async function redirectToHostedUi(page) {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(`${KEY}-pkce`, JSON.stringify({ verifier, state }));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid email profile",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  location.assign(`https://${config.domain}/${page}?${params}`);
}

async function exchange(code, state) {
  const pkce = JSON.parse(sessionStorage.getItem(`${KEY}-pkce`) ?? "{}");
  sessionStorage.removeItem(`${KEY}-pkce`);
  history.replaceState(null, "", location.pathname); // drop ?code=&state=
  if (!pkce.state || pkce.state !== state) throw new Error("sign-in state mismatch, please retry");
  const res = await fetch(`https://${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) throw new Error("sign-in failed, please retry");
  const tokens = await res.json();
  const session = { access_token: tokens.access_token, email: decode(tokens.id_token).email, expires_at: Date.now() + tokens.expires_in * 1000 };
  sessionStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

/** Loads the settings and finishes a hosted-login round trip; returns the session or null (guest). */
export async function init() {
  config = await (await fetch("/config.json", { cache: "no-store" })).json().catch(() => ({}));
  const params = new URLSearchParams(location.search);
  if (params.has("code")) return exchange(params.get("code"), params.get("state"));
  return readSession();
}

/** Current access token, or null for a guest or an expired session. */
export const token = () => readSession()?.access_token ?? null;

export const enabled = () => config?.auth === "cognito" || config?.auth === "dev";

/** page: "login" or "signup" (the hosted UI has both). */
export async function signIn(page = "login") {
  if (config?.auth === "dev") {
    const email = prompt("Local dev sign-in: any email address", "demo@example.com")?.trim();
    if (!email) return null;
    const session = { access_token: `dev:${email}`, email, expires_at: Date.now() + 3600_000 };
    sessionStorage.setItem(KEY, JSON.stringify(session));
    return session;
  }
  await redirectToHostedUi(page);
  return new Promise(() => {}); // the page is navigating away
}

export function expire() {
  sessionStorage.removeItem(KEY);
}

export function signOut() {
  expire();
  if (config?.auth !== "cognito") return location.reload();
  location.assign(`https://${config.domain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: config.redirectUri })}`);
}
