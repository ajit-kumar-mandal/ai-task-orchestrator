import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { fail, FailureCategory } from "./errors.mjs";

// v1.<iv>.<tag>.<ciphertext>, AES-256-GCM, key = HMAC-SHA256(shared, "longrun-tool-grant-v1"),
// AAD = `${task_id}:${app_user_id}`. A grant cannot be decrypted for another task or user.
const deriveKey = (sharedToken) => createHmac("sha256", sharedToken).update("longrun-tool-grant-v1", "utf8").digest();

export function encryptGrant(sharedToken, taskId, appUserId, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(sharedToken), iv);
  cipher.setAAD(Buffer.from(`${taskId}:${appUserId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptGrant(sharedToken, taskId, appUserId, encrypted) {
  const invalid = { category: FailureCategory.TERMINAL, stopReason: "grant_invalid" };
  const parts = typeof encrypted === "string" ? encrypted.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1") fail("The encrypted app authorization grant has an unsupported format.", invalid);
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ciphertext = Buffer.from(parts[3], "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) fail("The encrypted app authorization grant is malformed.", invalid);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(sharedToken), iv);
    decipher.setAAD(Buffer.from(`${taskId}:${appUserId}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return fail("The app authorization grant could not be decrypted for this task and user.", invalid);
  }
}
