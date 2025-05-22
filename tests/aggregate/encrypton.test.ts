import { decrypt, encrypt } from "../../src/aggregate/encryption";

const key = "key";
const value = "hello world"

describe("Encryption Tests", () => {
  it("should encrypt the string", () => {
    // arrange
    // act
    const encrypted = encrypt(value, key);
    
    // assert
    expect(encrypted).not.toEqual(value);
  });

  it("should decrypt the string", () => {
    // arrange
    // act
    const encrypted = encrypt(value, key);
    
    // assert
    expect(encrypted).not.toEqual(value);

    // act
    const decrypted = decrypt(encrypted, key);

    // assert
    expect(decrypted).toEqual(value)
  });
});
