import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  loader: () => window.api.ping(),
  component: Home,
});

function Home() {
  const reply = Route.useLoaderData();
  return (
    <main>
      <h1>Cockpit</h1>
      <p>Main process: {reply}</p>
    </main>
  );
}
