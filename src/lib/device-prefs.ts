import "server-only";
import { cookies } from "next/headers";
import { CONTRAST_COOKIE, HAND_COOKIE, OFFLINE_COOKIE } from "@/lib/device-cookies";

/**
 * Per-device preferences (plan #9 left hand, #37 sunlight mode). Cookies, not
 * the account: a phone and a desk computer can differ, and the server renders
 * the right layout first time with no flash.
 */

export {
  CONTRAST_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  HAND_COOKIE,
  OFFLINE_COOKIE,
} from "@/lib/device-cookies";

export type DevicePrefs = { leftHanded: boolean; sunlight: boolean; offline: boolean };

export async function devicePrefs(): Promise<DevicePrefs> {
  const jar = await cookies();
  return {
    leftHanded: jar.get(HAND_COOKIE)?.value === "left",
    sunlight: jar.get(CONTRAST_COOKIE)?.value === "high",
    offline: jar.get(OFFLINE_COOKIE)?.value === "on",
  };
}
