// Same UI for both solutions: every call goes to the relative /api path
// (ALB -> EC2 in solution 1, CloudFront -> API Gateway -> Lambda in solution 2).
export async function api(path, options = {}) {
  const res = await fetch("/api" + path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// Product images live in a dedicated S3 bucket; the API returns the object key
// ("images/covers/p-001.svg") and /images/* is routed to that bucket
// (CloudFront behavior in solution 2, presigned-URL redirect in solution 1).
export const imageUrl = (key) => (key ? "/" + key.replace(/^\/+/, "") : "");
