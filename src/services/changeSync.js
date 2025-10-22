// services/changeSync.js
import { ChangeLog } from '../models/ChangeLog.js';
import { CatalogSnapshot } from '../models/CatalogSnapshot.js';
import { Service } from '../models/Service.js';
import * as provider from '../lib/iplusviewAdapter.js';

const getProviderCatalog =
  provider.getProviderCatalog ??
  provider.fetchCatalog ??
  provider.listServices ??
  provider.getCatalog ??
  (async () => { throw new Error('Provider adapter does not expose a catalog fetcher.'); });

/** bootstrap snapshot & changelog ชุดแรกจาก DB ปัจจุบัน */
export async function runBootstrapIfNeeded() {
  const hasSnap = await CatalogSnapshot.findOne().lean();
  if (hasSnap) return { ok: true, bootstrapped: 0, already: true };

  const groups = await Service.find({ 'details.services.0': { $exists: true } }).lean();
  const map = new Map();
  const changes = [];
  const now = new Date();

  for (const g of groups) {
    const gOpen = (g.active ?? g.enabled ?? g.isActive ?? true) ? 'open' : 'close';
    map.set(`cat:${g._id}`, gOpen);
    changes.push({
      ts: now, target: 'category', diff: 'state',
      serviceGroupId: String(g._id), categoryName: g.name || '',
      oldStatus: undefined, newStatus: gOpen, isBootstrap: true
    });

    const children = Array.isArray(g.details?.services) ? g.details.services : [];
    for (const c of children) {
      const sOpen = (c.active ?? c.enabled ?? c.isActive ?? true) ? 'open' : 'close';
      map.set(`service:${c.id}`, sOpen);
      changes.push({
        ts: now, target: 'service', diff: 'state',
        providerServiceId: String(c.id), serviceName: c.name || '',
        platform: g.platform || g.categoryName || '',
        oldStatus: undefined, newStatus: sOpen, isBootstrap: true
      });
    }
  }

  await Promise.all([
    CatalogSnapshot.create({ map }),
    changes.length ? ChangeLog.insertMany(changes) : Promise.resolve()
  ]);

  return { ok: true, bootstrapped: changes.length };
}

/** diff กับ provider แล้วเขียน ChangeLog + snapshot ใหม่ */
export async function runSync() {
  // ให้แน่ใจว่ามี snapshot
  let snap = await CatalogSnapshot.findOne().sort({ createdAt: -1 }).lean();
  if (!snap) {
    await runBootstrapIfNeeded();
    snap = await CatalogSnapshot.findOne().sort({ createdAt: -1 }).lean();
  }

  const catalog = await getProviderCatalog();

  const newMap = new Map();
  const changes = [];
  const mark = (key, newStatus, payload) => {
    const oldStatus = snap.map?.get?.(key) || null;
    if (!oldStatus) {
      changes.push({ ts: new Date(), diff: 'new', oldStatus: null, newStatus, ...payload });
    } else if (oldStatus !== newStatus) {
      const diff = newStatus === 'open' ? 'open' : 'close';
      changes.push({ ts: new Date(), diff, oldStatus, newStatus, ...payload });
    }
    newMap.set(key, newStatus);
  };

  for (const g of catalog) {
    const gKey = `cat:${g._id ?? g.id ?? g.groupId ?? g.group?.id}`;
    const gName = g.name || g.categoryName || '';
    const gStatus = (g.active ?? g.enabled ?? g.isActive ?? true) ? 'open' : 'close';
    mark(gKey, gStatus, { target: 'category', serviceGroupId: String(g._id ?? g.id ?? gKey.slice(4)), categoryName: gName });

    const children = Array.isArray(g.details?.services) ? g.details.services : [];
    for (const s of children) {
      const sKey = `service:${s.id}`;
      const sStatus = (s.active ?? s.enabled ?? s.isActive ?? true) ? 'open' : 'close';
      mark(sKey, sStatus, {
        target: 'service', providerServiceId: String(s.id), serviceName: s.name || '',
        platform: g.platform || g.categoryName || ''
      });
    }
  }

  for (const [key, oldStatus] of snap.map?.entries?.() || []) {
    if (!newMap.has(key)) {
      const isSvc = key.startsWith('service:');
      changes.push({
        ts: new Date(),
        diff: 'removed',
        oldStatus,
        newStatus: null,
        ...(isSvc ? { target: 'service', providerServiceId: key.slice(8) }
                  : { target: 'category', serviceGroupId: key.slice(4) })
      });
    }
  }

  const [newSnap] = await Promise.all([
    CatalogSnapshot.create({ map: newMap }),
    changes.length ? ChangeLog.insertMany(changes) : Promise.resolve()
  ]);

  return { ok: true, wrote: changes.length, snapshotAt: newSnap.createdAt };
}
