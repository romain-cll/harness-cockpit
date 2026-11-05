import type { RouterHistory } from '@tanstack/react-router';

let latest: object | undefined;

// A flow that navigates after an `await` claims the navigation at the user's action. The returned check says whether it
// may still navigate: it is the latest claim and the user went nowhere since (every push, replace or pop gives
// `history.location` a new object).
export function claimNavigation(history: RouterHistory): () => boolean {
  const claim = {};
  latest = claim;
  const location = history.location;
  return () => latest === claim && history.location === location;
}
