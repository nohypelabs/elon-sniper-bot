import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGO = 'aes-256-gcm';

function getSecret(): Buffer {
  let secret = process.env.WALLET_ENCRYPTION_SECRET;
  if (!secret || secret.length < 64) {
    secret = crypto.randomBytes(32).toString('hex');
    process.env.WALLET_ENCRYPTION_SECRET = secret;
    try {
      const envPath = path.join(process.cwd(), '.env');
      const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      const re = /^WALLET_ENCRYPTION_SECRET=.*$/m;
      const line = `WALLET_ENCRYPTION_SECRET=${secret}`;
      fs.writeFileSync(envPath, re.test(content) ? content.replace(re, line) : content + `\n${line}`);
    } catch { /* ignore */ }
  }
  return Buffer.from(secret, 'hex');
}

export function encryptKey(plaintext: string): string {
  const key = getSecret();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptKey(data: string): string {
  const key = getSecret();
  const [ivHex, encHex, tagHex] = data.split(':');
  if (!ivHex || !encHex || !tagHex) throw new Error('Invalid encrypted data');
  const iv  = Buffer.from(ivHex,  'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}
