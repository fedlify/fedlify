import { describe, expect, it } from "vitest";
import { EFF_LARGE_WORDLIST } from "@/lib/eff-wordlist";
import { decryptKit, encryptKit, generateKitPassphrase, PASSPHRASE_ENTROPY_BITS } from "@/lib/kit-crypto";

// Low scrypt work factor keeps the unit tests quick; production uses age's default (18).
const WF = 10;
const plain = Buffer.from("PK-fake-zip-bytes-" + "x".repeat(200_000));

describe("kit passphrase", () => {
  it("draws at least five words from the 7776-word EFF list", () => {
    expect(EFF_LARGE_WORDLIST).toHaveLength(7776);
    expect(new Set(EFF_LARGE_WORDLIST).size).toBe(7776);
    const phrase = generateKitPassphrase();
    expect(phrase.split("-").length).toBeGreaterThanOrEqual(7);
    expect(PASSPHRASE_ENTROPY_BITS).toBeGreaterThanOrEqual(90);
    expect(() => generateKitPassphrase(4)).toThrow();
    expect(generateKitPassphrase()).not.toBe(phrase);
  });
});

describe("age passphrase encryption", () => {
  it("round trips and produces a real age file", async () => {
    const pass = generateKitPassphrase();
    const sealed = await encryptKit(plain, pass, WF);
    expect(sealed.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(sealed.toString("latin1")).toContain("-> scrypt");
    expect(sealed.includes(Buffer.from("fake-zip"))).toBe(false);
    expect(Buffer.compare(await decryptKit(sealed, pass), plain)).toBe(0);
  });

  it("fails with a wrong passphrase", async () => {
    const sealed = await encryptKit(plain, generateKitPassphrase(), WF);
    await expect(decryptKit(sealed, generateKitPassphrase())).rejects.toThrow();
  });

  it("fails when any part of the file is modified", async () => {
    const pass = generateKitPassphrase();
    const sealed = await encryptKit(plain, pass, WF);
    for (const index of [30, Math.floor(sealed.length / 2), sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = tampered[index]! ^ 0x01;
      await expect(decryptKit(tampered, pass)).rejects.toThrow();
    }
    await expect(decryptKit(sealed.subarray(0, sealed.length - 10), pass)).rejects.toThrow();
  });
});
