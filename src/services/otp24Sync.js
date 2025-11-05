// src/services/otp24Sync.js
import { Otp24Item } from '../models/Otp24Item.js';
import { Otp24TermGame } from '../models/Otp24TermGame.js';
import { getPack, getGames } from '../lib/otp24Adapter.js';
import { connectMongoIfNeeded } from '../config.js';

export async function syncOtp24All() {
  await connectMongoIfNeeded();

  let total = 0;
  const now = new Date();

  // ── 1) getpack → apppremium ────────────────────────────
  try {
    const list = await getPack(); // ควรได้เป็น array
    const items = Array.isArray(list) ? list : [];
    for (const p of items) {
      const doc = {
        category: 'apppremium',
        key: String(p.type_code ?? p.typeCode ?? p.type ?? p.name),
        name: p.name || p.app || '',
        price: Number(p.price ?? 0),
        img: p.img || '',
        desc: p.msg || '',
        amount: Number(p.amount ?? 0),
        meta: { exp: p.exp, app: p.app, raw: p },
        syncedAt: now,
      };
      await Otp24Item.updateOne(
        { category: doc.category, key: doc.key },
        { $set: doc },
        { upsert: true }
      );
      total++;
    }
  } catch (e) {
    // โยนทิ้งบางส่วน แต่ไม่ให้ทั้งงานพัง
    console.error('[otp24-sync] getpack failed:', e.message);
  }

  // ── 2) getgames → termgame (แตก denominationData เป็นหลายรายการ) ──
  try {
    const data = await getGames();                                 // <- คืนมาเป็น array แล้วจากแพตช์ unwrap
    const games = Array.isArray(data) ? data : [];
    console.log('[otp24-sync] getgames fetched:', games.length);

    for (const g of games) {
        const typeGame  = g.type_game || g.typeGame || g.code || g.namegame;
        const baseKey   = String(typeGame || g.namegame || g.name || Math.random());
        const baseName  = g.namegame || g.name || '';
        const baseImg   = g.img || g.img_icon || '';
        const baseDesc  = g.description || '';
        const denoms    = Array.isArray(g.denominationData) ? g.denominationData : [];
        const servers   = Array.isArray(g.savergame) ? g.savergame : [];

        // 2.1 เก็บ “ตัวเกม” ลงคอลเลกชัน otp24termgame (อัปเดต/เพิ่มตาม type_game)
        const gameDoc = {
        type_game: String(typeGame || ''),
        namegame: baseName,
        img: g.img ?? null,
        img_icon: g.img_icon ?? null,
        img_howto: g.img_howto ?? null,
        discount: Number(g.discount ?? 0),
        savergame: servers.map(s => ({ name: s.name ?? '', value: String(s.value ?? '') })),
        denominationData: denoms.map(d => ({
            type_code: (d.type_code ?? d.typeCode),
            price: Number(d.price ?? 0),
            description: d.description ?? ''
        })),
        updatedAt: now,
        };

        await Otp24TermGame.updateOne(
        { type_game: gameDoc.type_game },
        { $set: gameDoc, $setOnInsert: { createdAt: now } },
        { upsert: true }
        );

        // 2.2 สร้าง “รายการขาย” แตกตาม denominationData ลง Otp24Item (category=termgame)
        if (!denoms.length) {
        const doc = {
            category: 'termgame',
            key: baseKey,
            name: baseName,
            price: Number(g.price ?? 0),
            img: baseImg,
            desc: baseDesc,
            meta: { game: { type_game: typeGame }, raw: g },
            syncedAt: now,
        };
        await Otp24Item.updateOne(
            { category: doc.category, key: doc.key },
            { $set: doc },
            { upsert: true }
        );
        total++;
        } else {
        for (const d of denoms) {
            const typeCode = d.type_code ?? d.typeCode ?? d.code ?? d.id;
            const doc = {
            category: 'termgame',
            key: `${baseKey}:${typeCode}`, // unique ต่อ denomination
            name: `${baseName} — ${d.description || typeCode}`,
            price: Number(d.price ?? 0),
            img: baseImg,
            desc: d.description || '',
            meta: { game: { type_game: typeGame }, deno: d },
            syncedAt: now,
            };
            await Otp24Item.updateOne(
            { category: doc.category, key: doc.key },
            { $set: doc },
            { upsert: true }
            );
            total++;
        }
        }
    }
    } catch (e) {
    console.error('[otp24-sync] getgames failed:', e.message);
    }

  return { total, syncedAt: now };
}
