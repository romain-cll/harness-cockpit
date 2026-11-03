import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen';
import './styles.css';

// `blocking`: `await router.invalidate()` resolves once the loaders ran again. The default (`background`)
// resolves with the data already shown and reloads afterwards, so a page opened right after a change
// (a session started, a project added) showed the sidebar without it.
const router = createRouter({ routeTree, defaultStaleReloadMode: 'blocking' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
