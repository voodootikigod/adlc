// manifest-crypto.mjs — leaf Ed25519 signing, verification, and bounded
// admin.pub reader for ADLC manifests (zero runtime deps, Node 18+ node:crypto).

import {
  lstatSync,
  fstatSync,
  openSync,
  readSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson } from './canonical.mjs';

export const ADMIN_PUB_FILENAME = 'admin.pub';
export const PRIVATE_KEY_ENV = 'ADLC_MANIFEST_PRIVATE_KEY';
export const ED25519_PRIV_PREFIX = 'ed25519-priv:';
export const SIG_ALG_ED25519 = 'ed25519';

const MAX_ADMIN_PUB_BYTES = 4096;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
const ED25519_SIG_HEX_RE = /^[0-9a-f]{128}$/;

export function canonicalEntryBytes(entry) {
  if (entry.sigVersion === 2) {
    const { sig: _sig, segment: _segment, ...signed } = entry;
    return canonicalJson(signed);
  }
  const canonical = {
    seq: entry.seq,
    gate: entry.gate,
    ts: entry.ts,
  };
  if (entry.ticket !== undefined) canonical.ticket = entry.ticket;
  if (entry.data !== undefined) canonical.data = entry.data;
  canonical.files = entry.files;
  canonical.prev = entry.prev;
  return JSON.stringify(canonical);
}

export function isEd25519PrivateKey(key) {
  return typeof key === 'string' && key.startsWith(ED25519_PRIV_PREFIX);
}

function parsePrivateKey(privateKey) {
  if (!isEd25519PrivateKey(privateKey)) {
    throw new TypeError(`Ed25519 private key must start with "${ED25519_PRIV_PREFIX}"`);
  }
  const b64 = privateKey.slice(ED25519_PRIV_PREFIX.length);
  if (b64.length === 0 || !BASE64_RE.test(b64)) {
    throw new Error('invalid Ed25519 private key encoding');
  }
  const der = Buffer.from(b64, 'base64');
  const keyObj = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (keyObj.type !== 'private' || keyObj.asymmetricKeyType !== 'ed25519') {
    throw new Error('private key is not an Ed25519 key');
  }
  return keyObj;
}

function parsePublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('public key must be a canonical SPKI PEM string');
  }
  const keyObj = createPublicKey({ key: publicKey, format: 'pem', type: 'spki' });
  if (keyObj.type !== 'public' || keyObj.asymmetricKeyType !== 'ed25519') {
    throw new Error('public key is not an Ed25519 SPKI key');
  }
  return keyObj;
}

export function generateEd25519KeyPair() {
  const { publicKey: pubObj, privateKey: privObj } = generateKeyPairSync('ed25519');
  const pkcs8Der = privObj.export({ type: 'pkcs8', format: 'der' });
  const spkiPem = pubObj.export({ type: 'spki', format: 'pem' });
  const spkiDer = pubObj.export({ type: 'spki', format: 'der' });
  const keyFingerprint = createHash('sha256').update(spkiDer).digest('hex');
  return {
    privateKey: `${ED25519_PRIV_PREFIX}${pkcs8Der.toString('base64')}`,
    publicKey: spkiPem,
    keyFingerprint,
  };
}

export function derivePublicKeyPem(privateKey) {
  const privObj = parsePrivateKey(privateKey);
  const pubObj = createPublicKey(privObj);
  return pubObj.export({ type: 'spki', format: 'pem' });
}

export function signEntryEd25519(privateKey, entry) {
  const privObj = parsePrivateKey(privateKey);
  const payload = Buffer.from(canonicalEntryBytes(entry), 'utf8');
  return cryptoSign(null, payload, privObj).toString('hex');
}

export function verifyEntryEd25519(publicKeyOrPrivateKey, entry) {
  if (typeof entry?.sig !== 'string' || !ED25519_SIG_HEX_RE.test(entry.sig)) return false;
  if (typeof publicKeyOrPrivateKey !== 'string' || publicKeyOrPrivateKey.length === 0) return false;
  try {
    const pubObj = isEd25519PrivateKey(publicKeyOrPrivateKey)
      ? createPublicKey(parsePrivateKey(publicKeyOrPrivateKey))
      : parsePublicKey(publicKeyOrPrivateKey);
    const payload = Buffer.from(canonicalEntryBytes(entry), 'utf8');
    const sigBuf = Buffer.from(entry.sig, 'hex');
    return cryptoVerify(null, payload, pubObj, sigBuf);
  } catch {
    return false;
  }
}

export function readAdminPublicKey(dir = '.adlc') {
  const filePath = join(dir, ADMIN_PUB_FILENAME);
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'absent', publicKey: null };
    return { status: 'error', reason: `cannot stat ${ADMIN_PUB_FILENAME}: ${err.message}` };
  }
  if (st.isSymbolicLink()) {
    return { status: 'error', reason: `${ADMIN_PUB_FILENAME} is a symlink` };
  }
  if (!st.isFile()) {
    return { status: 'error', reason: `${ADMIN_PUB_FILENAME} is not a regular file` };
  }
  if (st.size > MAX_ADMIN_PUB_BYTES) {
    return { status: 'error', reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
  }

  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'absent', publicKey: null };
    if (err?.code === 'ELOOP') return { status: 'error', reason: `${ADMIN_PUB_FILENAME} is a symlink` };
    return { status: 'error', reason: `cannot open ${ADMIN_PUB_FILENAME}: ${err.message}` };
  }

  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) {
      return { status: 'error', reason: `${ADMIN_PUB_FILENAME} is not a regular file` };
    }
    if (fst.size > MAX_ADMIN_PUB_BYTES) {
      return { status: 'error', reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
    }
    const buf = Buffer.alloc(MAX_ADMIN_PUB_BYTES + 1);
    let total = 0;
    while (total <= MAX_ADMIN_PUB_BYTES) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_ADMIN_PUB_BYTES) {
      return { status: 'error', reason: `${ADMIN_PUB_FILENAME} exceeds ${MAX_ADMIN_PUB_BYTES} bytes` };
    }
    const raw = buf.subarray(0, total).toString('utf8');
    let pubObj;
    try {
      pubObj = parsePublicKey(raw);
    } catch {
      return { status: 'error', reason: `${ADMIN_PUB_FILENAME} is not a valid Ed25519 SPKI public key` };
    }
    return { status: 'ok', publicKey: pubObj.export({ type: 'spki', format: 'pem' }) };
  } catch (err) {
    return { status: 'error', reason: `cannot read ${ADMIN_PUB_FILENAME}: ${err.message}` };
  } finally {
    closeSync(fd);
  }
}
