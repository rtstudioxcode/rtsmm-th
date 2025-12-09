// src/services/telegramLogin.js
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { computeCheck } from "telegram/Password.js";

/* ============================================================================
   Utility
============================================================================ */
function makeClient({ sessionString = "", apiId, apiHash, options = {}, proxy = null }) {
  return new TelegramClient(
    new StringSession(sessionString),
    Number(apiId),
    String(apiHash),
    {
      connectionRetries: 3,
      requestRetries: 3,
      timeout: 15000,
      autoReconnect: true,
      ...(proxy ? { proxy } : {}),
      ...options,
    }
  );
}

/* DC MIGRATION HANDLER */
async function dcRetry(client, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String(e);
    const m = /(PHONE_MIGRATE|NETWORK_MIGRATE|USER_MIGRATE)_(\d+)/i.exec(msg);
    if (m) {
      const dcId = Number(m[2]);
      await client._switchDC(dcId);
      return await fn();
    }
    throw e;
  }
}

/* ============================================================================
   STEP 1 — SEND CODE
============================================================================ */
export async function sendCodeAndGetSession({ phone, apiId, apiHash, options, proxy }) {
  const client = makeClient({ apiId, apiHash, options, proxy });

  try {
    if (!client.connected) await client.connect();

    const res = await dcRetry(
      client,
      () =>
        client.invoke(
          new Api.auth.SendCode({
            phoneNumber: String(phone),
            apiId: Number(apiId),
            apiHash: String(apiHash),
            settings: new Api.CodeSettings({}),
          })
        )
    );

    return {
      ok: true,
      phoneCodeHash: res.phoneCodeHash,
      sessionString: client.session.save(),
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}

/* ============================================================================
   STEP 1.1 — RESEND CODE
============================================================================ */
export async function resendCode({ sessionString, phone, phoneCodeHash, apiId, apiHash }) {
  const client = makeClient({ sessionString, apiId, apiHash });

  try {
    if (!client.connected) await client.connect();

    const res = await dcRetry(
      client,
      () =>
        client.invoke(
          new Api.auth.ResendCode({
            phoneNumber: String(phone),
            phoneCodeHash: String(phoneCodeHash),
          })
        )
    );

    return {
      ok: true,
      phoneCodeHash: res.phoneCodeHash,
      sessionString: client.session.save(),
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}

/* ============================================================================
   STEP 2 — SIGN IN WITH OTP
============================================================================ */
export async function signInWithSession({
  sessionString,
  phone,
  phoneCodeHash,
  code,
  apiId,
  apiHash,
}) {
  const client = makeClient({ sessionString, apiId, apiHash });

  try {
    if (!client.connected) await client.connect();

    await dcRetry(
      client,
      () =>
        client.invoke(
          new Api.auth.SignIn({
            phoneNumber: String(phone),
            phoneCodeHash: String(phoneCodeHash),
            phoneCode: String(code),
          })
        )
    );

    const me = await client.getMe();

    return {
      ok: true,
      me,
      sessionString: client.session.save(),
    };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      return {
        ok: false,
        needPassword: true,
        sessionString: client.session.save(),
      };
    }

    return { ok: false, error: msg };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}

/* ============================================================================
   STEP 2.5 — CHECK 2FA PASSWORD (SRP)
============================================================================ */
export async function checkPasswordWithSession({
  sessionString,
  password,
  apiId,
  apiHash,
}) {
  const client = makeClient({ sessionString, apiId, apiHash });

  try {
    if (!client.connected) await client.connect();

    // 1) ดึงข้อมูลรหัสผ่าน/คีย์ SRP
    const pwd = await dcRetry(client, () => client.invoke(new Api.account.GetPassword()));

    // 2) คำนวณ SRP check
    const check = await computeCheck(pwd, String(password));

    // 3) ส่งกลับไปให้ Telegram ตรวจสอบ
    await dcRetry(
      client,
      () =>
        client.invoke(
          new Api.auth.CheckPassword({
            password: check,
          })
        )
    );

    const me = await client.getMe();

    return {
      ok: true,
      me,
      sessionString: client.session.save(),
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try { await client.disconnect(); } catch {}
    try { await client.destroy?.(); } catch {}
  }
}
