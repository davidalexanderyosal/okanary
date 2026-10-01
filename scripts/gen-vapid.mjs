// Generates a VAPID keypair for Web Push. Usage: npm run vapid
// Then: wrangler secret put VAPID_PRIVATE_KEY; wrangler secret put VAPID_PUBLIC_KEY; wrangler secret put VAPID_SUBJECT (mailto:you@example.com)
// For local dev put the same three values in .dev.vars (gitignored).
import { webcrypto as crypto } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
