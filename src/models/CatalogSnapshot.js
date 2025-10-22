// models/CatalogSnapshot.js
import mongoose from 'mongoose';

const CatalogSnapshotSchema = new mongoose.Schema({
  createdAt: { type: Date, default: Date.now, index: true },
  // เก็บ mapping เบาๆ: key -> 'open'|'close'
  // key รูปแบบ:
  // - service:<providerServiceId>
  // - cat:<serviceGroupId>
  map: { type: Map, of: String }
});

export const CatalogSnapshot = mongoose.model('CatalogSnapshot', CatalogSnapshotSchema);
