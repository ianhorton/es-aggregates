import { decrypt, encrypt } from "../../src/aggregate/encryption";

const key = "key";
const value = "hello world"

describe("Encryption Tests", () => {
  it("should encrypt the string", () => {
  
    const encrypted = encrypt(value, key);
    
    expect(encrypted).not.toEqual(value);
  });

  it("should decrypt the string", () => {
  
    const encrypted = encrypt(value, key);
    
    expect(encrypted).not.toEqual(value);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toEqual(value)
  });
});
