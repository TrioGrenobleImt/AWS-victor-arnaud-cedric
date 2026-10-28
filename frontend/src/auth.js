// Customer accounts, straight against the Cognito user pool API (no hosted login
// page, no SDK): sign up, confirm the emailed code, sign in, reset the password.
// Signing in is optional: guests can still order.
// config.json is written by Terraform: { auth: "cognito", region, clientId }.
// In local dev it is { auth: "dev" }: any email + password "signs in" and the
// local backend accepts the token "dev:<email>".
const KEY = "fisa-shop-session";
let config = {};

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  NotAuthorizedException: "Incorrect email or password.",
  UserNotFoundException: "Incorrect email or password.",
  UsernameExistsException: "An account with this email already exists. Try signing in.",
  CodeMismatchException: "That code is not right. Check the email and try again.",
  ExpiredCodeException: "That code has expired. Ask for a new one.",
  LimitExceededException: "Too many attempts. Wait a little and retry.",
  TooManyRequestsException: "Too many attempts. Wait a little and retry.",
  TooManyFailedAttemptsException: "Too many attempts. Wait a little and retry.",
};

async function cognito(target, body) {
  const res = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: config.clientId, ...body }),
  }).catch(() => {
    throw new AuthError("Could not reach the sign-in service. Check your connection.");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.__type ?? "").split("#").pop();
    throw new AuthError(MESSAGES[code] ?? data.message ?? "Something went wrong, please retry.", code);
  }
  return data;
}

const decode = (jwt) => JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

function readSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(KEY));
    return session && session.expires_at > Date.now() + 30_000 ? session : null;
  } catch {
    return null;
  }
}

function store(session) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {} // private mode: signed in for this page view only
  return session;
}

/** Loads the settings; returns the current session or null (guest). */
export async function init() {
  config = await (await fetch("/config.json", { cache: "no-store" })).json().catch(() => ({}));
  return readSession();
}

export const enabled = () => config.auth === "cognito" || config.auth === "dev";

/** Current access token, or null for a guest or an expired session. */
export const token = () => readSession()?.access_token ?? null;

export async function signIn(email, password) {
  if (config.auth === "dev") return store({ access_token: `dev:${email}`, email, expires_at: Date.now() + 3600_000 });
  const { AuthenticationResult: r } = await cognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  return store({ access_token: r.AccessToken, email: decode(r.IdToken).email ?? email, expires_at: Date.now() + r.ExpiresIn * 1000 });
}

/** Creates the account; Cognito emails a confirmation code (confirmSignUp). */
export async function signUp(email, password) {
  if (config.auth === "dev") return;
  await cognito("SignUp", { Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] });
}

export async function confirmSignUp(email, code) {
  if (config.auth === "dev") return;
  await cognito("ConfirmSignUp", { Username: email, ConfirmationCode: code.trim() });
}

export async function resendCode(email) {
  if (config.auth !== "dev") await cognito("ResendConfirmationCode", { Username: email });
}

export async function forgotPassword(email) {
  if (config.auth !== "dev") await cognito("ForgotPassword", { Username: email });
}

export async function resetPassword(email, code, password) {
  if (config.auth !== "dev") await cognito("ConfirmForgotPassword", { Username: email, ConfirmationCode: code.trim(), Password: password });
}

export function expire() {
  sessionStorage.removeItem(KEY);
}

export function signOut() {
  const bearer = token();
  expire();
  if (config.auth === "cognito" && bearer) cognito("GlobalSignOut", { AccessToken: bearer }).catch(() => {}); // revokes the refresh token too
}
