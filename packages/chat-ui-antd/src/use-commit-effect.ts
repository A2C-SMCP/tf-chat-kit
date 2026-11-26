import { useEffect, useLayoutEffect } from "react";

export const useCommitEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
