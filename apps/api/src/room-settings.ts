/**
 * Room settings JSON parsing (mirrors `parseOrgSettings`). Corrupt/absent JSON
 * falls back to full defaults so reads never error. `{ description }` only.
 */
import { RoomSettingsSchema, type RoomSettings } from '@sparrow/common-types';

/** Parse a room's stored `settings` JSON into the defaults-merged object. */
export function parseRoomSettings(raw: string | null | undefined): RoomSettings {
  try {
    return RoomSettingsSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return RoomSettingsSchema.parse({});
  }
}
