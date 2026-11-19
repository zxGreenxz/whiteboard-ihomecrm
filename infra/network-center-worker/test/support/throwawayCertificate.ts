import { createHash, generateKeyPairSync, sign } from "node:crypto";

// TEST ONLY. A new key and certificate are generated in memory on every call
// and never written to disk, so no private key lives in the repository and
// nothing here belongs to a real device. The certificate is deliberately the
// kind a recorder ships with: self-signed, expired years ago, and named after
// an unrelated documentation address.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length])
    : body.length < 0x100 ? Buffer.from([0x81, body.length])
    : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const SEQUENCE = 0x30;
const sha256WithRsa = der(SEQUENCE, der(0x06, Buffer.from("2a864886f70d01010b", "hex")), der(0x05));
const commonName = (value: string) => der(SEQUENCE, der(0x31, der(SEQUENCE, der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from(value, "utf8")))));
const utcTime = (value: string) => der(0x17, Buffer.from(value, "ascii"));

export interface ThrowawayCertificate {
  key: string;
  cert: string;
  /** Lower-case hex SHA-256 of the DER certificate, the form a pin is compared in. */
  fingerprint256: string;
}

export function throwawayCertificate(): ThrowawayCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const name = commonName("192.0.2.1");
  const body = der(SEQUENCE,
    der(0x02, Buffer.from([0x01])), sha256WithRsa, name,
    der(SEQUENCE, utcTime("160101000000Z"), utcTime("170101000000Z")),
    name, publicKey.export({ type: "spki", format: "der" }));
  const certificate = der(SEQUENCE, body, sha256WithRsa, der(0x03, Buffer.from([0x00]), sign("sha256", body, privateKey)));
  const lines = certificate.toString("base64").match(/.{1,64}/gu) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: ["-----BEGIN CERTIFICATE-----", ...lines, "-----END CERTIFICATE-----", ""].join("\n"),
    fingerprint256: createHash("sha256").update(certificate).digest("hex"),
  };
}
