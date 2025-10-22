import mongoose from 'mongoose';
export const Subcategory = mongoose.model('Subcategory', new mongoose.Schema({
  category: { type: mongoose.Types.ObjectId, ref: 'Category', index: true },
  name: String,
  slug: { type: String, index: true },
}));
