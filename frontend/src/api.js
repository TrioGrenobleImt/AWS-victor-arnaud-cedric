// Every call goes to the relative /api path: CloudFront -> ALB -> ECS (Express).
export async function api(path, options = {}) {
  const res = await fetch("/api" + path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// Product images live in a dedicated S3 bucket; the API returns the object key
// ("images/covers/p-001.svg") and CloudFront routes /images/* to that bucket.
export const imageUrl = (key) => (key ? "/" + key.replace(/^\/+/, "") : "");
