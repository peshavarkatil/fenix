// Unlocking and storing the data. Everything here happens inside your phone.
// The passphrase is never sent anywhere. The file on GitHub is unreadable without it.
const MAGIC = [0x46, 0x44, 0x58, 0x31]; // "FDX1"
const SALT = 16, NONCE = 12, ITER = 600000;
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

export class WrongPassphrase extends Error {}

export function parse(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 4 + SALT + NONCE + 16 || MAGIC.some((b, i) => u[i] !== b)) throw new WrongPassphrase("This isn't a Fenix data file.");
  return { header: u.slice(0, 4 + SALT), salt: u.slice(4, 4 + SALT), nonce: u.slice(4 + SALT, 4 + SALT + NONCE), ct: u.slice(4 + SALT + NONCE) };
}
export const saltHex = (buf) => hex(parse(buf).salt);

export async function deriveKey(passphrase, salt) {
  const clean = passphrase.normalize("NFKC").trim();
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(clean), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
export async function decrypt(buf, key) {
  const { header, nonce, ct } = parse(buf);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new WrongPassphrase("Wrong passphrase, or the data file is damaged."); }
}

// ---- remembered key + last file (IndexedDB). The key is non-extractable: even this
// page's own code can't read its bytes, it can only use it to decrypt.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("fenix", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => { const tx = db.transaction("kv", mode); const out = fn(tx.objectStore("kv")); tx.oncomplete = () => res(out?.result); tx.onerror = () => rej(tx.error); });
  } catch { return undefined; } // private mode etc: the app still works, it just asks again
}
export const saved = { get: (k) => kv("readonly", (s) => s.get(k)), set: (k, v) => kv("readwrite", (s) => s.put(v, k)), del: (k) => kv("readwrite", (s) => s.delete(k)) };

export async function fetchBlob() {
  const r = await fetch("./data.bin?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 404 ? "no-data" : "http " + r.status);
  return r.arrayBuffer();
}
