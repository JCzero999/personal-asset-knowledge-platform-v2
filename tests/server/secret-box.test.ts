import { describe, expect, it } from "vitest";

import {
  SecretBoxError,
  decryptSecret,
  encryptSecret,
  maskSecret,
  resolveSettingsSecret,
} from "../../src/server/security/secret-box";

const SECRET = "unit-test-settings-key-0123456789";

describe("secret-box（ADR-025）", () => {
  it("加密后可原样解回（含中文与符号）", () => {
    const plain = "sk-测试-key-!@#$%^&*()_+-=中文";
    const payload = encryptSecret(plain, SECRET);

    expect(payload.startsWith("v1.")).toBe(true);
    expect(payload).not.toContain(plain);
    expect(decryptSecret(payload, SECRET)).toBe(plain);
  });

  it("同一明文两次加密得到不同密文（随机 IV）", () => {
    const a = encryptSecret("same-value", SECRET);
    const b = encryptSecret("same-value", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe("same-value");
    expect(decryptSecret(b, SECRET)).toBe("same-value");
  });

  it("换密钥解不开", () => {
    const payload = encryptSecret("sk-abcdef123456", SECRET);
    expect(() => decryptSecret(payload, `${SECRET}x`)).toThrowError(SecretBoxError);
  });

  it("篡改密文 / 标签 / 格式都会失败且不泄露内容", () => {
    const payload = encryptSecret("sk-abcdef123456", SECRET);
    const [, iv, tag, data] = payload.split(".");

    for (const bad of [
      ["v1", iv, tag, `${data.slice(0, -2)}AA`].join("."),
      ["v1", iv, tag.slice(0, -4), data].join("."),
      ["v2", iv, tag, data].join("."),
      "not-a-payload",
    ]) {
      let message = "";
      try {
        decryptSecret(bad, SECRET);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain("sk-abcdef");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("掩码只留可辨认的前缀与末 4 位", () => {
    expect(maskSecret("sk-1234567890abcdef")).toBe("sk-…cdef");
    expect(maskSecret("short")).toBe("…rt");
    expect(maskSecret("abc")).toBe("…");
    expect(maskSecret("")).toBeNull();
    expect(maskSecret(null)).toBeNull();

    const masked = maskSecret("sk-1234567890abcdef")!;
    expect(masked).not.toBe("sk-1234567890abcdef");
    expect(masked).not.toContain("7890");
  });

  it("只认专用 SETTINGS_ENC_KEY，不再回退 Logto 密钥", () => {
    expect(resolveSettingsSecret({ SETTINGS_ENC_KEY: "k".repeat(32) })).toBe("k".repeat(32));
    expect(resolveSettingsSecret({ LOGTO_COOKIE_SECRET: "logto-cookie" })).toBeNull();
    expect(resolveSettingsSecret({ AUTH_SECRET: "auth" })).toBeNull();
    expect(resolveSettingsSecret({ SETTINGS_ENC_KEY: "   " })).toBeNull();
    expect(resolveSettingsSecret({})).toBeNull();
  });
});
