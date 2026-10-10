import "server-only";
import { cookies } from "next/headers";

/**
 * Per-device preferences (plan #9 left hand, #37 sunlight mode). Cookies, not
 * the account: a phone and a desk computer can differ, and the server renders
 * the right layout first time with no flash.
 */
export const HAND_COOKIE = "sa_hand";
export const CONTRAST_COOKIE = "sa_contrast";
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // the browser maximum

export type DevicePrefs = { leftHanded: boolean; sunlight: boolean };

export async function devicePrefs(): Promise<DevicePrefs> {
  const jar = await cookies();
  return {
    leftHanded: jar.get(HAND_COOKIE)?.value === "left",
    sunlight: jar.get(CONTRAST_COOKIE)?.value === "high",
  };
}
