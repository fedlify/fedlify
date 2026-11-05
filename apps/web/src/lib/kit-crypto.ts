import { randomInt } from "node:crypto";
import { Decrypter, Encrypter } from "age-encryption";
import { EFF_LARGE_WORDLIST } from "@/lib/eff-wordlist";

// Site-kit encryption: the `age` file format, passphrase (scrypt) mode, via the pure-JS `age-encryption` package
// (BSD-3, no native code, so it bundles into the Next.js route and the standalone build without serverExternalPackages).
// The output is a standard age file: `age -d kit.zip.age` decrypts it on the site machine.

export const PASSPHRASE_WORDS = 7;
/** age's own default (about one second of scrypt on a server core). Work factor and word count are chosen together. */
export const AGE_SCRYPT_WORK_FACTOR = 18;
/** 7 words from 7776 is log2(7776^7) = 90.5 bits. */
export const PASSPHRASE_ENTROPY_BITS = Math.floor(PASSPHRASE_WORDS * Math.log2(EFF_LARGE_WORDLIST.length));

/** Fresh diceware passphrase from the OS CSPRNG (rejection-sampled `randomInt`, so no modulo bias). Never stored or logged. */
export function generateKitPassphrase(words = PASSPHRASE_WORDS): string {
  if (words < 5) throw new Error("A kit passphrase needs at least five words.");
  const picked: string[] = [];
  for (let i = 0; i < words; i++) picked.push(EFF_LARGE_WORDLIST[randomInt(EFF_LARGE_WORDLIST.length)]!);
  return picked.join("-");
}

export async function encryptKit(plain: Uint8Array, passphrase: string, workFactor = AGE_SCRYPT_WORK_FACTOR): Promise<Buffer> {
  const encrypter = new Encrypter();
  encrypter.setScryptWorkFactor(workFactor);
  encrypter.setPassphrase(passphrase);
  return Buffer.from(await encrypter.encrypt(plain));
}

/** Used by tests and diagnostics. Throws on a wrong passphrase or any modified byte (age authenticates every chunk). */
export async function decryptKit(encrypted: Uint8Array, passphrase: string): Promise<Buffer> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  return Buffer.from(await decrypter.decrypt(encrypted));
}
