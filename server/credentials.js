// Encrypted storage for the Garmin Personal API key.
//
// The key is never stored in plain text. It is encrypted with AES-256-GCM
// using a key derived (scrypt) from the dashboard password, so the file on
// disk is useless without that password. A separate scrypt hash with its own
// salt verifies the password at login.

import { randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MIN_PASSWORD_LENGTH = 10;

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export class CredentialError extends Error {}

export class CredentialStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'credentials.json');
  }

  async exists() {
    try {
      await fs.access(this.file);
      return true;
    } catch {
      return false;
    }
  }

  async save(password, apiKey) {
    validatePassword(password);
    const key = normalizeApiKey(apiKey);
    const verifySalt = randomBytes(16);
    const encSalt = randomBytes(16);
    const iv = randomBytes(12);
    const verifier = await derive(password, verifySalt);
    const encKey = await derive(password, encSalt);
    const cipher = createCipheriv('aes-256-gcm', encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const record = {
      version: 1,
      createdAt: new Date().toISOString(),
      verifySalt: verifySalt.toString('base64'),
      verifier: verifier.toString('base64'),
      encSalt: encSalt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  // Returns the decrypted API key, or throws CredentialError for a wrong password.
  async unlock(password) {
    const record = JSON.parse(await fs.readFile(this.file, 'utf8'));
    const verifier = await derive(String(password ?? ''), Buffer.from(record.verifySalt, 'base64'));
    const expected = Buffer.from(record.verifier, 'base64');
    if (verifier.length !== expected.length || !timingSafeEqual(verifier, expected)) {
      throw new CredentialError('Falsches Passwort');
    }
    const encKey = await derive(password, Buffer.from(record.encSalt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  async remove() {
    await fs.rm(this.file, { force: true });
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new CredentialError(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
  }
}

export function normalizeApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length < 8 || /\s/.test(key)) {
    throw new CredentialError('Der API-Schlüssel sieht ungültig aus (zu kurz oder enthält Leerzeichen).');
  }
  return key;
}
