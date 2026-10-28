// Cognito hosted login (authorization code + PKCE, no client secret in the browser).
// config.json is written by Terraform: { auth: "cognito", domain, clientId, redirectUri }.
// In local dev it is { auth: "dev" } and the local backend accepts the token "dev".
const KEY = "fisa-admin-session";
let config;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(KEY));
    return session && session.expires_at > Date.now() + 30_000 ? session : null;
  } catch {
    return null;
  }
}

async function login() {
  const verifier = randomString();
  const state = randomString();
  sessionStorage.setItem(`${KEY}-pkce`, JSON.stringify({ verifier, state, hash: location.hash }));
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
  location.assign(`https://${config.domain}/oauth2/authorize?${params}`);
  return new Promise(() => {}); // the page is navigating away
}

async function exchange(code, state) {
  const pkce = JSON.parse(sessionStorage.getItem(`${KEY}-pkce`) ?? "{}");
  sessionStorage.removeItem(`${KEY}-pkce`);
  if (!pkce.state || pkce.state !== state) throw new Error("login state mismatch, please retry");
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
  if (!res.ok) throw new Error("login failed, please retry");
  const tokens = await res.json();
  const claims = JSON.parse(atob(tokens.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  const session = { access_token: tokens.access_token, email: claims.email, expires_at: Date.now() + tokens.expires_in * 1000 };
  sessionStorage.setItem(KEY, JSON.stringify(session));
  history.replaceState(null, "", `${location.pathname}${pkce.hash || ""}`); // drop ?code=&state=
  return session;
}

/** Returns a valid session, finishing or starting the hosted login when needed. */
export async function session() {
  config ??= await (await fetch("/config.json", { cache: "no-store" })).json();
  if (config.auth === "dev") return { access_token: "dev", email: "dev-admin (local)" };
  const params = new URLSearchParams(location.search);
  if (params.has("code")) return exchange(params.get("code"), params.get("state"));
  return readSession() ?? login();
}

export function expire() {
  sessionStorage.removeItem(KEY);
}

export function logout() {
  expire();
  if (config?.auth !== "cognito") return location.reload();
  location.assign(`https://${config.domain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: config.redirectUri })}`);
}
