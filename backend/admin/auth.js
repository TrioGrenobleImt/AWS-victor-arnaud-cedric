// Back-office authentication: Cognito access tokens (from the hosted login page)
// are verified locally against the user pool's public keys; only members of the
// "admins" group get through.
import { CognitoJwtVerifier } from "aws-jwt-verify";

export const ADMIN_GROUP = "admins";

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
      req.admin = await verify(token);
    } catch {
      return res.status(401).json({ error: "invalid or expired token" });
    }
    next();
  };
}
