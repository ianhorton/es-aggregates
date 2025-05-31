import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-cbc";
const ENCODING = "hex";
const IV_LENGTH = 16;

const prepareKey = (key: string): string => {
  return createHash("sha256")
    .update(String(key))
    .digest("base64")
    .substr(0, 32);
};

function encrypt(data: string, key: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(prepareKey(key)), iv);
  return Buffer.concat([cipher.update(data), cipher.final(), iv]).toString(
    ENCODING
  );
}

function decrypt(data: string, key: string): string {
  const binaryData = Buffer.from(data, ENCODING);
  const iv = binaryData.slice(-IV_LENGTH);
  const encryptedData = binaryData.slice(0, binaryData.length - IV_LENGTH);
  const decipher = createDecipheriv(
    ALGORITHM,
    Buffer.from(prepareKey(key)),
    iv
  );

  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]).toString();
}

export { encrypt, decrypt };
