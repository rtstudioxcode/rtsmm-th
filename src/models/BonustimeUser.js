import mongoose from "mongoose";
import { getBonustimeDb } from "../db/mongoBonustime.js";

const BonustimeUserSchema = new mongoose.Schema(
  {
    tenantId: String,
    serial_key: String,
    NAME: String,
    CHANNEL_ACCESS_TOKEN: String,
    CHANNEL_SECRET: String,
    LOGO: String,
    LOGIN_URL: String,
    SIGNUP_URL: String,
    LINE_ADMIN: String,
    ALLOW_TEXT_PROVIDER: Boolean,
    LOTTO_ENABLED: Boolean,
    LICENSE_START_DATE: String,
    LICENSE_DURATION_DAYS: Number,
    LICENSE_DISABLED: Boolean,
    LINK: String,
    expiryNotifySent: Date,
  },
  { collection: "users" }
);

export const BonustimeUser = getBonustimeDb().model(
  "users",
  BonustimeUserSchema
);
