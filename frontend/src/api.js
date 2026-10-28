import { expire, token } from "./auth.js";

// Every call goes to the relative /api path: CloudFront -> ALB -> ECS (Express).
// The customer's access token is sent when signed in.
export async function api(path, options = {}) {
  const bearer = token();
  const res = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(bearer && { Authorization: `Bearer ${bearer}` }) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && bearer) {
    expire(); // revoked or expired: carry on as a guest
    throw new Error("Your session expired, please sign in again.");
  }
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// Product images live in a dedicated S3 bucket; the API returns the object key
// ("images/covers/p-001.svg") and CloudFront routes /images/* to that bucket.
export const imageUrl = (key) => (key ? "/" + key.replace(/^\/+/, "") : "");
