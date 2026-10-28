import { expire, session } from "./auth.js";

/** Calls the admin API (/admin/api/*) with the admin's access token. */
export async function api(path, { method = "GET", body } = {}) {
  const { access_token } = await session();
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${access_token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    expire(); // expired or revoked: sign in again
    await session();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Uploads an image straight to S3 with a presigned POST; returns its key ("images/uploads/…"). */
export async function uploadImage(file) {
  const { url, fields, key } = await api("/uploads", { method: "POST", body: { content_type: file.type } });
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", file); // must be last
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(res.status === 400 ? "image rejected (max 5 MB, JPG/PNG/WebP)" : `upload failed (${res.status})`);
  return key;
}

export const imageUrl = (key) => (key ? `/${key}` : "");
