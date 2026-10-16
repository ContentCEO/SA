"use client";

import { useEffect, useState } from "react";
import {
  captureLandingSource,
  EMPTY_LANDING_SOURCE,
  type LandingSource,
} from "@/lib/landing-source";

/** The four hidden "came from" fields a public sign-up form sends along. */
export function SourceFields() {
  const [source, setSource] = useState<LandingSource>(EMPTY_LANDING_SOURCE);
  useEffect(() => {
    // Read after mount: the server render has no location or referrer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource(captureLandingSource());
  }, []);
  return (
    <>
      {(Object.keys(source) as (keyof LandingSource)[]).map((k) => (
        <input key={k} type="hidden" name={k} value={source[k]} />
      ))}
    </>
  );
}

/** On public pages without a form: remember where this tab came from for a later sign-up. */
export function SourceCapture() {
  useEffect(() => {
    captureLandingSource();
  }, []);
  return null;
}
