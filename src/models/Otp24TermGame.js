// src/models/Otp24TermGame.js
import mongoose from 'mongoose';

const ServerSchema = new mongoose.Schema({
  name: String,   // ชื่อ server
  value: String,  // รหัส server
}, { _id:false });

const DenomSchema = new mongoose.Schema({
  type_code: mongoose.Schema.Types.Mixed, // บางเกมเป็นทศนิยม
  price: Number,
  description: String,
}, { _id:false });

const Otp24TermGameSchema = new mongoose.Schema({
  type_game: { type: String, unique: true, index: true },
  namegame: String,
  img: String,
  img_icon: String,
  img_howto: String,
  discount: Number,
  savergame: [ServerSchema],
  denominationData: [DenomSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'otp24termgame' });

export const Otp24TermGame = mongoose.model('Otp24TermGame', Otp24TermGameSchema);
