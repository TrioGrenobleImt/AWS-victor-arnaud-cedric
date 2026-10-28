// Back-office authentication: Cognito access tokens (from the hosted login page)
// are verified locally against the user pool's public keys; only members of the
// "admins" group get through.
//
// Roles are Cognito groups: every back-office user is in "admins" (can use the
// app: orders, products, dashboard); members of "owners" can also manage the
// team (create, change and remove back-office accounts).
import { CognitoJwtVerifier } from "aws-jwt-verify";

export const ADMIN_GROUP = "admins";
export const OWNER_GROUP = "owners";
export const ROLES = ["staff", "owner"];

export const roleOf = (groups = []) => (groups.includes(OWNER_GROUP) ? "owner" : "staff");

export function cognitoVerifier({ userPoolId, clientId }) {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access", groups: ADMIN_GROUP });
  return async (token) => {
    const payload = await verifier.verify(token);
    return { username: payload.username, groups: payload["cognito:groups"] ?? [] };
  };
}

/** Express middleware: `verify(token)` resolves to the admin identity or throws. */
export function requireAdmin(verify) {
  return async (req, res, next) => {
    const [scheme, token] = (req.get("authorization") ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return res.status(401).json({ error: "missing bearer token" });
    try {
      const admin = await verify(token);
      req.admin = { ...admin, role: roleOf(admin.groups) };
    } catch {
      return res.status(401).json({ error: "invalid or expired token" });
    }
    next();
  };
}

/**
 * Express middleware: only owners. The token's groups can be up to an hour old,
 * so the role is re-read from the directory: a demoted, disabled or removed
 * owner loses access to team management immediately.
 */
export function requireOwner(directory) {
  return async (req, res, next) => {
    if (req.admin.role !== "owner") return res.status(403).json({ error: "only owners can manage the team" });
    const current = await directory.get(req.admin.username);
    if (!current?.enabled || current.role !== "owner") return res.status(403).json({ error: "only owners can manage the team" });
    next();
  };
}
