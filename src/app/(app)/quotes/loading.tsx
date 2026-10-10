// Not on /admin or per-customer pages: those must return a real 404 status, which streaming would turn into 200.
export { ScreenSkeleton as default } from "@/components/app/screen-skeleton";
