# Development

Node 24 is the normal development runtime (`.nvmrc`); 22.16 is the minimum supported runtime.

```sh
npm ci
npm run check
node dist/cli.js init --db ./scratch.sqlite
node dist/cli.js capture --db ./scratch.sqlite --file examples/capture.json
```

Production code is under src/, black-box and storage tests under test/, synthetic data under examples/.
No database, web server, browser installation, API key or account is needed to run tests.
Keep the lockfile. Runtime dependencies are intentionally empty. Dependencies and Actions should be pinned and reviewed.

A change should contain its acceptance criteria, relevant regression test, and updated contract/design documentation.
For migrations, retain a fixture of the previous schema and test forward migration plus export/restore.
Do not rewrite old IDs to correct a statement: use replacement records, relations, and reviews.

`npm pack` builds a local package archive for testing; `private: true` prevents registry publication.
Choosing a distribution license and public package name is a separate owner decision.

For a suspected bug, include the command, Node version, error code and a small synthetic reproduction.
Do not upload your real SQLite file, snapshot or source quotations to a public issue.
