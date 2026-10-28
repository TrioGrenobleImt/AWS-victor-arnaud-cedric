// Customer authentication: Cognito access tokens from the storefront's hosted
// login (a separate user pool from the back office) are verified locally.
// Anyone can sign up; there is no group, a valid token is enough.
import { CognitoJwtVerifier } from "aws-jwt-verify";

export function cognitoCustomerVerifier({ userPoolId, clientId }) {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  return async (token) => {
    const { sub } = await verifier.verify(token);
    return { sub };
  };
}

const bearer = (req) => {
  const [scheme, token] = (req.get("authorization") ?? "").split(" ");
  return scheme === "Bearer" && token ? token : null;
};

async function identify(verify, req, res) {
  try {
    req.customer = await verify(bearer(req));
    return true;
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
    return false;
  }
}

/** Express middleware: attaches `req.customer` when a token is sent, lets guests through. */
export const optionalCustomer = (verify) => async (req, res, next) => {
  if (!bearer(req)) return next();
  if (await identify(verify, req, res)) next();
};

/** Express middleware: the request must carry a valid customer token. */
export const requireCustomer = (verify) => async (req, res, next) => {
  if (!bearer(req)) return res.status(401).json({ error: "sign in required" });
  if (await identify(verify, req, res)) next();
};
