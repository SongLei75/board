import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function identityPath(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'carizon', 'board-session', 'identity.pem');
}

function validate(pem: Buffer): void {
  const text = pem.toString('utf8');
  const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length) throw new Error('Identity must contain a private key and X.509 certificate');
  const key = createPrivateKey(pem);
  if (!['ec', 'rsa'].includes(key.asymmetricKeyType ?? '')) {
    throw new Error('wolfSSH X.509 identity requires an EC or RSA private key');
  }
  const chain = certificates.map(cert => new X509Certificate(cert));
  if (!chain[0].checkPrivateKey(key)) throw new Error('Identity certificate does not match its private key');
}

export async function setIdentity(pem: Buffer | string): Promise<void> {
  if (typeof pem !== 'string' && !Buffer.isBuffer(pem)) throw new TypeError('Identity must be a Buffer or string');
  const content = Buffer.from(pem);
  validate(content);
  const target = identityPath();
  const directory = join(target, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    content.fill(0);
    await rm(temporary, { force: true });
  }
}

export async function readIdentity(): Promise<Buffer> {
  try {
    return await readFile(identityPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Board identity is not configured; call BoardSession.setIdentity(pem) first');
    }
    throw error;
  }
}
