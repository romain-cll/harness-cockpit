# AGENTS.md — cockpit

**cockpit** est un nom de travail provisoire. On le retrouve dans le nom du binaire (`cockpit-mcp`) et dans le dossier de données (`~/.cockpit`).

## Règle n° 1 : pas de sur-engineering

N'ajouter aucune abstraction, aucun package ni aucune app au-delà de ce que décrit ce fichier. En cas de doute, faire le plus simple.

## Produit

Application desktop qui pilote des CLI d'agents (Claude Code, Codex, OpenCode, Kimi, Mistral, Cursor CLI…) via node-pty, sur le modèle projets / workspaces de Superset.

Différenciateurs :
- sessions hors projet (exploration multi-agent sans dépôt) ;
- **mémoire partagée entre harness** ;
- artifacts sur un stockage à soi ;
- statistiques de consommation.

Le dépôt couvre aujourd'hui **uniquement la mémoire cross-harness**, sous la forme d'un serveur MCP local classique, utilisable avec le `claude` de base. Daemon, Electron, pty, UI, artifacts, stats, backend cloud réel, embeddings, mobile : ne rien en créer sans demande explicite.

## Architecture

```
Claude Code ──stdio──▶ cockpit-mcp (serveur MCP) ──────────▶ MemoryService ──▶ LocalStore (~/.cockpit : md + SQLite FTS)
            ──hook───▶ cockpit-mcp hook session-start ──┘                  └─▶ CloudStore (stub)
```

- `cockpit-mcp` est un serveur MCP **stdio** standard, **lancé automatiquement par Claude Code**. L'utilisateur ne lance jamais rien à la main.
- Le même binaire sert de hook `SessionStart` (sous-commande `hook session-start`) : il injecte le contexte mémoire au démarrage de la session.
- **Pas de daemon.** Le process MCP embarque directement `packages/memory`. Plusieurs sessions en parallèle donnent plusieurs process sur les mêmes fichiers, ce que SQLite en mode WAL gère.
- **Projet courant** = racine git du `process.cwd()`. Aucun header, port ni token.

### Principes à respecter

1. **Tools MCP indépendants du transport.** `packages/mcp-server` exporte `createMcpServer(service, context)`. `apps/mcp` le monte en stdio ; le même serveur doit pouvoir être monté en HTTP sans réécriture, donc aucun code propre à stdio dans `packages/mcp-server`.
2. **Stockage derrière une interface unique** (`MemoryStore`). Le choix local / cloud se fait **uniquement** dans `apps/mcp/src/main.ts`, à partir de la config.
3. **Aucune logique métier dans `apps/`.** Tout vit dans `packages/`, les apps ne font que câbler.

## Monorepo

- **Bun** (gestionnaire de paquets, workspaces, lancement des scripts) + **Turborepo**, TypeScript.
- Runtime du binaire : **Node 22+**. `better-sqlite3` est un module natif Node.
- Initialisé à la main, sans template `create-turbo` :
  - `package.json` racine : workspaces `apps/*` et `packages/*`, scripts qui délèguent à Turbo ;
  - `turbo.json` : tâches `build`, `dev`, `test`, `typecheck`, `lint` ;
  - `tsconfig.base.json`, étendu par chaque package.
- Dépendances internes déclarées en `"workspace:*"`.

```
apps/
  mcp/               # bin `cockpit-mcp` : serveur MCP stdio + sous-commande `hook session-start`
packages/
  memory/            # types, scopes, interface MemoryStore, MemoryService, LocalStore, CloudStore (stub)
  mcp-server/        # définition des tools MCP, ne dépend que de MemoryService
scripts/
  install-claude.ts  # installation globale pour Claude Code (+ désinstallation)
```

- Pas d'autre app (daemon, desktop, cloud) sans demande explicite.
- **Packages internes consommés en source TS**, sans build séparé par package.
- **`apps/mcp`** est bundlé avec `tsup` en un seul binaire. `better-sqlite3` reste en dépendance externe, parce que c'est un module natif.
- **Tests** avec `vitest`, **validation** avec `zod`.

### Commandes

```sh
bun install
bun run build       # turbo run build
bun run test        # turbo run test
bun run typecheck   # turbo run typecheck
bun run lint        # turbo run lint
bun turbo run build test typecheck   # plusieurs tâches en une passe
```

## Stockage

```ts
// packages/memory
interface MemoryStore {
  write(entry: NewMemory): Promise<Memory>;
  update(id: string, patch: Partial<NewMemory>): Promise<Memory>;
  delete(id: string): Promise<void>;
  search(q: SearchQuery): Promise<Memory[]>;
  list(filter: ListFilter): Promise<Memory[]>;
}
```

- **`LocalStore`** :
  - fichiers markdown + frontmatter dans `~/.cockpit/memory/{global,projects/<projectId>,sessions/<sessionId>}/<id>.md` ;
  - index SQLite FTS5 dans `~/.cockpit/index.db`, mode WAL ;
  - **les fichiers sont la source de vérité**, l'index est reconstructible à partir d'eux.
- **`CloudStore`** : stub qui lève « not implemented ».
- **Config** dans `~/.cockpit/config.json` :
  ```json
  { "memory": { "backend": "local" } }
  { "memory": { "backend": "cloud", "url": "https://…", "token": "…" } }
  ```
- Pas de synchro local ↔ cloud : c'est l'un ou l'autre.

## Modèle de données

- **Scopes** : `global`, `project`, `session`.
- **`projectId`** : hash du chemin racine git du cwd. Sans git, hash du cwd, ce qui couvre les sessions hors projet.
- **`sessionId`** : généré au démarrage du process MCP (un process par session Claude). La reprise de session (`--resume`) n'est pas gérée.
- **Entrée** : `id`, `scope`, `projectId?`, `sessionId?`, `content` (markdown), `tags[]`, `pinned`, `source` (harness), `createdAt`, `updatedAt`.
- Visibilité : une mémoire `project` n'apparaît que dans son projet ; une mémoire `global` apparaît partout.

## Tools MCP (`packages/mcp-server`)

| Tool | Entrée | Notes |
|---|---|---|
| `memory_search` | `query`, `scope?` (`all` par défaut), `limit?` | FTS, tri par pertinence puis récence |
| `memory_write` | `content`, `scope`, `tags?`, `pinned?` | renvoie l'`id` |
| `memory_update` | `id`, `content?`, `tags?`, `pinned?` | |
| `memory_delete` | `id` | |

Le projet et la session viennent du `context` passé à `createMcpServer`. L'agent ne les passe jamais lui-même.

## Hook `SessionStart` (`cockpit-mcp hook session-start`)

1. Lit le JSON reçu sur stdin (`cwd`, `session_id`…).
2. Construit un bloc markdown à partir du store :
   - les instructions d'usage (quand appeler `memory_search` / `memory_write`) ;
   - toutes les mémoires `global` ;
   - les mémoires `project` épinglées, puis les plus récentes ;
   - le tout dans un budget fixe (~2k tokens, configurable).
3. L'imprime sur stdout pour qu'il soit injecté dans le contexte.

### À vérifier dans la doc et en pratique, sans se fier à sa mémoire

- Le cwd d'un serveur MCP stdio lancé par Claude Code est-il bien le dossier du projet ? Sinon, chercher une variable d'env fournie (ex. `CLAUDE_PROJECT_DIR`).
- Le format d'entrée des hooks `SessionStart` et la façon dont leur stdout est injecté en contexte.

## Installation (`scripts/install-claude.ts`)

Idempotent :
- `claude mcp add --scope user cockpit -- <chemin du binaire cockpit-mcp>` ;
- ajout du hook `SessionStart` dans `~/.claude/settings.json` : merge, **backup avant écriture**, aucune modification si le hook est déjà présent ;
- script de désinstallation symétrique, qui restaure l'état initial.

Les MCP et hooks déjà configurés par l'utilisateur doivent continuer de fonctionner.

## Autres harness

- **Codex** : même binaire, déclaré dans `~/.codex/config.toml` (`mcp_servers`).
- Pour injecter le contexte au démarrage d'un harness, ne **jamais** modifier l'`AGENTS.md` du dépôt de l'utilisateur.

## Tests et validation

- `packages/memory` (vitest) : CRUD, FTS, filtrage par scope, reconstruction de l'index depuis les fichiers, écritures concurrentes de 2 process.
- `apps/mcp` : le binaire répond en stdio (tester avec MCP Inspector) ; le hook imprime le bloc de contexte attendu.
- Bout en bout, après `install-claude`, avec le `claude` de base dans un vrai dépôt :
  - « Retiens que X » → Claude appelle `memory_write` (scope `project`) ;
  - nouvelle session dans le même dépôt → X est présent **sans** appel à `memory_search` (injection par le hook) ;
  - dans un autre dépôt, X est absent ; une mémoire `global` est présente partout ;
  - les MCP et hooks existants fonctionnent toujours, la désinstallation restaure l'état initial.
