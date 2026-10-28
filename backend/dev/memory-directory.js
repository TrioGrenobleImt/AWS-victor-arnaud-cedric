// In-memory stand-in for admin/directory.js (local dev and tests): no Cognito needed.
import { randomUUID } from "node:crypto";

export function memoryDirectory(seed = []) {
  const users = new Map();
  const add = ({ username = randomUUID(), email, role = "staff", enabled = true, status = "CONFIRMED" }) => {
    const user = { username, email, role, enabled, status, created_at: new Date().toISOString() };
    users.set(username, user);
    return user;
  };
  seed.forEach(add);
  const copy = (u) => (u ? { ...u } : null);

  return {
    invitations: [], // emails an invitation would have been sent to
    async get(username) {
      return copy(users.get(username));
    },
    async list() {
      return [...users.values()].map(copy).sort((a, b) => a.email.localeCompare(b.email));
    },
    async create({ email, role }) {
      if ([...users.values()].some((u) => u.email === email)) return null;
      this.invitations.push(email);
      return copy(add({ email, role, status: "FORCE_CHANGE_PASSWORD" }));
    },
    async setRole(username, role) {
      users.get(username).role = role;
    },
    async setEnabled(username, enabled) {
      users.get(username).enabled = enabled;
    },
    async remove(username) {
      users.delete(username);
    },
  };
}
