// Check 8 P6: a tap on More shows this at once on a slow signal. Safe here: /more never calls
// notFound() (unlike /admin and /customers/[key], which must keep a real 404 and so no loading).
import { ScreenSkeleton } from "@/components/app/screen-skeleton";

export default function Loading() {
  return <ScreenSkeleton rows="menu" />;
}
